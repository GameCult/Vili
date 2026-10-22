import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { admitThen, createGpuTenancy, parseSample, placementRefusal, startProbe } from "./gpu-tenancy.mjs";

const SEC = 1000;
const CLEAR = { quns: 1, freeMiB: 14000, util3d: 1 };

function rig(options = {}) {
  let t = 1_000_000;
  const gate = createGpuTenancy({ now: () => t, ...options });
  return {
    gate,
    t0: t,
    at: () => t,
    advance: (ms) => { t += ms; },
    feed(sample, afterMs = 15 * SEC) {
      t += afterMs;
      gate.observe(sample);
    },
  };
}

function freeRig(options) {
  const r = rig(options);
  for (let i = 0; i < 13; i += 1) r.feed(CLEAR); // the 13th sample is 180 s after the first
  assert.equal(r.gate.status().inUse, false, "precondition: gate is free");
  return r;
}

test("hysteresis: busy holds for the clear window", () => {
  const r = freeRig();
  r.feed({ ...CLEAR, quns: 3 });
  const busyAt = r.at();
  assert.deepEqual(r.gate.status(), { inUse: true, since: busyAt, checkedAt: busyAt, probeOk: true });
  for (let elapsed = 15; elapsed < 180; elapsed += 15) {
    r.feed(CLEAR);
    assert.equal(r.gate.status().inUse, true, `still held ${elapsed} s into the hold`);
    assert.equal(r.gate.status().since, busyAt);
  }
  // a busy sample late in the hold restarts it
  r.feed({ ...CLEAR, quns: 2 });
  const restartAt = r.at();
  for (let elapsed = 15; elapsed < 180; elapsed += 15) {
    r.feed(CLEAR);
    assert.equal(r.gate.status().inUse, true, `restarted hold, ${elapsed} s`);
  }
  r.feed(CLEAR);
  assert.equal(r.at() - restartAt, 180 * SEC);
  const freedAt = r.at();
  assert.deepEqual(r.gate.status(), { inUse: false, since: freedAt, checkedAt: freedAt, probeOk: true });
  r.feed(CLEAR);
  assert.equal(r.gate.status().since, freedAt, "since moves only when the state turns");
  r.feed({ ...CLEAR, freeMiB: 100 });
  assert.deepEqual(r.gate.status(), { inUse: true, since: r.at(), checkedAt: r.at(), probeOk: true });
});

test("hysteresis: a busy sample just before the window ends restarts it", () => {
  const r = rig();
  r.feed(CLEAR);
  for (let i = 0; i < 11; i += 1) r.feed(CLEAR);
  assert.equal(r.gate.status().inUse, true, "165 s clear is not enough");
  r.feed({ ...CLEAR, quns: 3 });
  r.feed(CLEAR);
  r.feed(CLEAR);
  assert.equal(r.gate.status().inUse, true);
});

test("sustained 3D, immediate full-screen and VRAM", () => {
  const spike = freeRig();
  spike.feed({ ...CLEAR, util3d: 80 });
  spike.feed(CLEAR);
  assert.equal(spike.gate.status().inUse, false, "one 3D spike between clear samples");

  const sustained = freeRig();
  sustained.feed({ ...CLEAR, util3d: 80 });
  assert.equal(sustained.gate.status().inUse, false, "first high sample alone");
  sustained.feed({ ...CLEAR, util3d: 80 });
  assert.equal(sustained.gate.status().inUse, true, "two consecutive high samples");

  const edge = freeRig();
  edge.feed({ ...CLEAR, util3d: 20 });
  edge.feed({ ...CLEAR, util3d: 20 });
  assert.equal(edge.gate.status().inUse, false, "exactly the threshold is not above it");

  for (const [name, sample] of [
    ["QUNS_BUSY", { ...CLEAR, quns: 2 }],
    ["QUNS_RUNNING_D3D_FULL_SCREEN", { ...CLEAR, quns: 3 }],
    ["low free VRAM", { ...CLEAR, freeMiB: 10239 }],
  ]) {
    const r = freeRig();
    r.feed(sample);
    assert.equal(r.gate.status().inUse, true, name);
  }

  const enough = freeRig();
  enough.feed({ ...CLEAR, freeMiB: 10240 });
  assert.equal(enough.gate.status().inUse, false, "free VRAM equal to the minimum is enough");

  const otherStates = freeRig();
  for (const quns of [1, 4, 5, 6, 7]) otherStates.feed({ ...CLEAR, quns });
  assert.equal(otherStates.gate.status().inUse, false, "other notification states are not household use");
});

test("thresholds from the options are honored", () => {
  const r = rig({ minFreeMiB: 500, util3dBusyPct: 90, clearHoldMs: 30 * SEC });
  r.feed({ ...CLEAR, freeMiB: 600, util3d: 85 });
  r.feed({ ...CLEAR, freeMiB: 600, util3d: 85 });
  r.feed({ ...CLEAR, freeMiB: 600, util3d: 85 });
  assert.equal(r.gate.status().inUse, false);
  r.feed({ ...CLEAR, freeMiB: 400 });
  assert.equal(r.gate.status().inUse, true);
});

test("start and stale fail closed", () => {
  const r = rig();
  assert.deepEqual(r.gate.status(), { inUse: true, since: r.t0, checkedAt: null, probeOk: true });
  for (let i = 0; i < 13; i += 1) r.feed(CLEAR);
  assert.equal(r.gate.status().inUse, false);
  const lastSample = r.at();

  r.advance(45 * SEC);
  assert.equal(r.gate.status().probeOk, true, "exactly 3 intervals is not stale yet");
  r.advance(1);
  const stale = r.gate.status();
  assert.equal(stale.inUse, true);
  assert.equal(stale.probeOk, false);
  assert.equal(stale.since, lastSample + 45 * SEC);
  assert.equal(stale.checkedAt, lastSample);

  r.feed(CLEAR, 0);
  assert.equal(r.gate.status().inUse, true, "samples resumed but the hold has not passed");
  assert.equal(r.gate.status().probeOk, true);
  for (let i = 0; i < 11; i += 1) r.feed(CLEAR);
  assert.equal(r.gate.status().inUse, true);
  r.feed(CLEAR);
  assert.equal(r.gate.status().inUse, false);
});

test("a gate that never hears from its probe stays in use and not ok", () => {
  const r = rig();
  r.advance(46 * SEC);
  assert.deepEqual(r.gate.status(), { inUse: true, since: r.t0, checkedAt: null, probeOk: false });
});

test("defer, not kill", async () => {
  const r = freeRig();
  let release;
  let started = 0;
  const running = admitThen(r.gate, () => {
    started += 1;
    return new Promise((resolve) => { release = () => resolve({ ok: true, value: "finished" }); });
  });
  assert.equal(started, 1);
  r.feed({ ...CLEAR, quns: 3 });
  assert.equal(r.gate.status().inUse, true, "the gate went busy while the job runs");

  let secondCalls = 0;
  const second = await admitThen(r.gate, async () => { secondCalls += 1; });
  assert.equal(secondCalls, 0, "a second job is refused without being called");
  assert.equal(second.code, "gpu-busy");

  release();
  assert.deepEqual(await running, { ok: true, value: "finished" });
});

test("a job that fails is not swallowed by the gate", async () => {
  const r = freeRig();
  await assert.rejects(admitThen(r.gate, async () => { throw new Error("job failed"); }), /job failed/);
});

test("typed busy result", async () => {
  const r = rig();
  r.feed({ ...CLEAR, quns: 3 });
  const since = r.gate.status().since;
  r.feed({ ...CLEAR, quns: 3 });
  r.feed({ ...CLEAR, quns: 3 });
  let calls = 0;
  const refusal = await admitThen(r.gate, async () => { calls += 1; });
  assert.deepEqual(refusal, {
    ok: false,
    code: "gpu-busy",
    source: "admission",
    gpu: { inUse: true, since, checkedAt: r.at(), probeOk: true },
  });
  assert.equal(calls, 0);
});

test("placement refusal is keyed on the typed code, never on text", () => {
  const gpu = { inUse: false, since: 1, checkedAt: 2, probeOk: true };
  assert.deepEqual(placementRefusal({ ok: false, code: "gpu-busy", error: "x" }, gpu, "vili-1"), {
    ok: false, code: "gpu-busy", source: "placement", gpu, jobId: "vili-1",
  });
  assert.equal(placementRefusal({ ok: false, error: "gpu-busy: 0.50 GiB of VRAM free" }, gpu, "vili-1"), null);
  assert.equal(placementRefusal({ ok: false, code: null }, gpu, "vili-1"), null);
  assert.equal(placementRefusal(null, gpu, "vili-1"), null);
});

test("no program name canary", () => {
  const canary = "canary-vili-7f3a";
  const line = JSON.stringify({ quns: 3, freeMiB: 2048, util3d: 55.5, name: canary, process: canary, instance: canary });
  const sample = parseSample(line);
  assert.deepEqual(sample, { quns: 3, freeMiB: 2048, util3d: 55.5 });
  assert.deepEqual(Object.keys(sample).sort(), ["freeMiB", "quns", "util3d"]);
  const r = rig();
  r.gate.observe(sample);
  assert.equal(JSON.stringify(r.gate.status()).includes(canary), false);
});

test("parseSample drops anything that is not three finite numbers", () => {
  assert.equal(parseSample("not json"), null);
  assert.equal(parseSample("null"), null);
  assert.equal(parseSample("[1,2,3]"), null);
  assert.equal(parseSample(JSON.stringify({ quns: 1, freeMiB: 1 })), null);
  assert.equal(parseSample(JSON.stringify({ quns: "1", freeMiB: 1, util3d: 1 })), null);
  assert.equal(parseSample('{"quns":1,"freeMiB":1,"util3d":1e999}'), null);
  assert.equal(parseSample(""), null);
});

function fakeSpawn() {
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    spawned.push({ command, args, options, child });
    return child;
  };
  return { spawn, spawned };
}

test("probe: one hidden child, lines become samples, junk is dropped", () => {
  const { spawn, spawned } = fakeSpawn();
  const samples = [];
  const probe = startProbe({ spawn, scriptPath: "gpu-tenancy-probe.ps1", intervalMs: 15000, onSample: (s) => samples.push(s), parentPid: 4242 });
  assert.equal(spawned.length, 1);
  const { command, args, options, child } = spawned[0];
  assert.equal(command, "powershell.exe");
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
  assert.deepEqual(args.slice(args.indexOf("-ParentPid")), ["-ParentPid", "4242", "-IntervalMs", "15000"]);
  assert.ok(args.includes("-File") && args.includes("gpu-tenancy-probe.ps1"));

  child.stdout.emit("data", '{"quns":1,"freeMiB":14000,"util3d":2}\n{"quns":2,"free');
  child.stdout.emit("data", 'MiB":9000,"util3d":3}\r\ngarbage\n');
  assert.deepEqual(samples, [
    { quns: 1, freeMiB: 14000, util3d: 2 },
    { quns: 2, freeMiB: 9000, util3d: 3 },
  ]);
  probe.stop();
});

test("probe: respawns at most once per interval after the child exits", async () => {
  const { spawn, spawned } = fakeSpawn();
  const probe = startProbe({ spawn, scriptPath: "p.ps1", intervalMs: 80, onSample: () => {} });
  spawned[0].child.emit("exit", 1);
  spawned[0].child.emit("error", new Error("again"));
  spawned[0].child.emit("exit", 1);
  assert.equal(spawned.length, 1, "no immediate respawn");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(spawned.length, 2, "one respawn for one death, however many events");
  probe.stop();
  spawned[1].child.emit("exit", 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(spawned.length, 2, "a stopped probe does not respawn");
});
