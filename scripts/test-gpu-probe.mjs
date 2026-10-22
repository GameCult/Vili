import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UTIL3D_COUNTER_PATH, parseSample, startProbe } from "./gpu-probe.mjs";
import { createGpuTenancy } from "./gpu-tenancy.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("no program name canary", () => {
  const canary = "canary-vili-7f3a";
  const line = JSON.stringify({ quns: 3, freeMiB: 2048, util3d: 55.5, engines: 8, name: canary, process: canary, instance: canary });
  const sample = parseSample(line);
  assert.deepEqual(sample, { quns: 3, freeMiB: 2048, util3d: 55.5, engines: 8 });
  assert.deepEqual(Object.keys(sample).sort(), ["engines", "freeMiB", "quns", "util3d"]);
  const gate = createGpuTenancy({ now: () => 1_000_000 });
  gate.observe(sample);
  assert.equal(JSON.stringify(gate.status()).includes(canary), false);
});

test("parseSample drops anything that is not four finite numbers", () => {
  const ok = { quns: 1, freeMiB: 1, util3d: 1, engines: 1 };
  assert.deepEqual(parseSample(JSON.stringify(ok)), ok);
  assert.equal(parseSample("not json"), null);
  assert.equal(parseSample("null"), null);
  assert.equal(parseSample("[1,2,3]"), null);
  assert.equal(parseSample(""), null);
  for (const field of Object.keys(ok)) {
    const missing = { ...ok };
    delete missing[field];
    assert.equal(parseSample(JSON.stringify(missing)), null, `${field} missing`);
    assert.equal(parseSample(JSON.stringify({ ...ok, [field]: "1" })), null, `${field} as a string`);
  }
  assert.equal(parseSample('{"quns":1,"freeMiB":1,"util3d":1e999,"engines":1}'), null);
});

test("the 3D counter path is the one constant, and the script has no copy of it", async () => {
  assert.equal(UTIL3D_COUNTER_PATH, "\\GPU Engine(*engtype_3D)\\Utilization Percentage");
  const script = await readFile(new URL("./gpu-tenancy-probe.ps1", import.meta.url), "utf8");
  assert.equal(/GPU Engine|engtype/.test(script.replace(/^#.*$/gm, "")), false, "the path reaches the script as -Util3dPath only");
  assert.match(script, /Get-Counter \$Util3dPath/);
  assert.match(script, /engines = \$counters\.Count/);
});

test("a probe that resolved no 3D counters keeps the gate failing closed", () => {
  let t = 1_000_000;
  const gate = createGpuTenancy({ now: () => t });
  const line = (engines) => JSON.stringify({ quns: 1, freeMiB: 14000, util3d: 0, engines });
  for (let i = 0; i < 20; i += 1) {
    t += 15_000;
    gate.observe(parseSample(line(0)));
  }
  assert.deepEqual(gate.status(), { inUse: true, since: 1_000_000, checkedAt: null, probeOk: false });
  for (let i = 0; i < 13; i += 1) {
    t += 15_000;
    gate.observe(parseSample(line(8)));
  }
  assert.equal(gate.status().inUse, false, "the same clear samples with a resolved counter do clear the gate");
  assert.equal(gate.status().probeOk, true);
});

function fakeSpawn() {
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = (encoding) => { child.encoding = encoding; };
    child.kills = 0;
    child.kill = () => { child.kills += 1; };
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
  assert.deepEqual(args, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", "gpu-tenancy-probe.ps1", "-ParentPid", "4242", "-IntervalMs", "15000",
    "-Util3dPath", UTIL3D_COUNTER_PATH,
  ]);
  assert.equal(child.encoding, "utf8");

  child.stdout.emit("data", '{"quns":1,"freeMiB":14000,"util3d":2,"engines":4}\n{"quns":2,"free');
  child.stdout.emit("data", 'MiB":9000,"util3d":3,"engines":4}\r\ngarbage\n');
  assert.deepEqual(samples, [
    { quns: 1, freeMiB: 14000, util3d: 2, engines: 4 },
    { quns: 2, freeMiB: 9000, util3d: 3, engines: 4 },
  ]);
  probe.stop();
});

test("probe: respawns at most once per interval after the child exits", async () => {
  const { spawn, spawned } = fakeSpawn();
  const probe = startProbe({ spawn, scriptPath: "p.ps1", intervalMs: 80, onSample: () => {} });
  spawned[0].child.emit("exit", 1);
  spawned[0].child.emit("error", new Error("again"));
  spawned[0].child.emit("exit", 1);
  await sleep(30);
  assert.equal(spawned.length, 1, "no respawn inside the interval");
  await sleep(170);
  assert.equal(spawned.length, 2, "one respawn for one death, however many events");
  probe.stop();
  spawned[1].child.emit("exit", 1);
  await sleep(200);
  assert.equal(spawned.length, 2, "a stopped probe does not respawn");
});

test("probe: a plain exit and a spawn error each respawn", async () => {
  const exited = fakeSpawn();
  const a = startProbe({ spawn: exited.spawn, scriptPath: "p.ps1", intervalMs: 20, onSample: () => {}, staleIntervals: 1000 });
  exited.spawned[0].child.emit("exit", 0);
  await sleep(120);
  assert.equal(exited.spawned.length, 2);
  a.stop();
  const failed = fakeSpawn();
  const b = startProbe({ spawn: failed.spawn, scriptPath: "p.ps1", intervalMs: 20, onSample: () => {}, staleIntervals: 1000 });
  failed.spawned[0].child.emit("error", new Error("ENOENT"));
  await sleep(120);
  assert.equal(failed.spawned.length, 2);
  b.stop();
});

test("probe watchdog: a child that stays alive but sends nothing is killed and respawned once", async () => {
  const { spawn, spawned } = fakeSpawn();
  const probe = startProbe({ spawn, scriptPath: "p.ps1", intervalMs: 40, onSample: () => {} });
  await sleep(90);
  assert.equal(spawned[0].child.kills, 0, "under 3 intervals of silence the child is left alone");
  assert.equal(spawned.length, 1);
  await sleep(100);
  assert.equal(spawned[0].child.kills, 1, "the hung child is killed exactly once");
  assert.equal(spawned.length, 2, "and replaced");
  spawned[0].child.emit("exit", 1);
  const line = '{"quns":1,"freeMiB":14000,"util3d":1,"engines":4}\n';
  for (let i = 0; i < 4; i += 1) {
    await sleep(40);
    spawned[1].child.stdout.emit("data", line);
  }
  assert.equal(spawned.length, 2, "the killed child's exit adds no second respawn");
  assert.equal(spawned[1].child.kills, 0);
  probe.stop();
});

test("probe watchdog: samples keep a child alive, and a dead child is not killed again", async () => {
  const { spawn, spawned } = fakeSpawn();
  const probe = startProbe({ spawn, scriptPath: "p.ps1", intervalMs: 40, onSample: () => {} });
  const line = '{"quns":1,"freeMiB":14000,"util3d":1,"engines":4}\n';
  for (let i = 0; i < 10; i += 1) {
    await sleep(40);
    spawned[0].child.stdout.emit("data", line);
  }
  assert.equal(spawned[0].child.kills, 0, "a child that samples is never killed");
  assert.equal(spawned.length, 1);
  spawned[0].child.emit("exit", 1);
  await sleep(400);
  assert.equal(spawned[0].child.kills, 0, "a child that already exited is not killed");
  probe.stop();
});
