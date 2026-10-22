import assert from "node:assert/strict";
import test from "node:test";
import { admitThen, createGpuTenancy, gpuTenancyOptionsFromEnv, placementRefusal } from "./gpu-tenancy.mjs";

const SEC = 1000;
const CLEAR = { quns: 1, freeMiB: 14000, util3d: 1, engines: 8 };

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
  r.feed(CLEAR); // the hold counts from the first clear sample
  const holdStart = r.at();
  for (let elapsed = 15; elapsed <= 165; elapsed += 15) {
    r.feed(CLEAR);
    assert.equal(r.gate.status().inUse, true, `restarted hold, ${elapsed} s clear`);
  }
  r.feed(CLEAR);
  assert.equal(r.at() - holdStart, 180 * SEC);
  assert.ok(r.at() > restartAt);
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
  edge.feed({ ...CLEAR, util3d: 80 });
  edge.feed({ ...CLEAR, util3d: 20 });
  assert.equal(edge.gate.status().inUse, false, "high then exactly the threshold");
  const edgeUp = freeRig();
  edgeUp.feed({ ...CLEAR, util3d: 20 });
  edgeUp.feed({ ...CLEAR, util3d: 80 });
  assert.equal(edgeUp.gate.status().inUse, false, "exactly the threshold then high");

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

test("a stale start keeps since at the start when samples resume busy", () => {
  const r = rig();
  r.advance(60 * SEC);
  r.feed({ ...CLEAR, quns: 3 }, 0);
  assert.deepEqual(r.gate.status(), { inUse: true, since: r.t0, checkedAt: r.at(), probeOk: true });
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

test("placement refusal is keyed on the typed code, never on text, and carries no gate status", () => {
  assert.deepEqual(placementRefusal({ ok: false, code: "gpu-busy", error: "x" }, "vili-1"), {
    ok: false, code: "gpu-busy", source: "placement", jobId: "vili-1",
  });
  assert.equal(placementRefusal({ ok: false, error: "gpu-busy: 0.50 GiB of VRAM free" }, "vili-1"), null);
  assert.equal(placementRefusal({ ok: false, code: null }, "vili-1"), null);
  assert.equal(placementRefusal(null, "vili-1"), null);
});


// ---- the slot: one job at a time, judged where the GPU is taken ----

const OWN = { ...CLEAR, freeMiB: 1800 }; // the encoder child holds the VRAM

test("slot: a second request while a job runs is refused as a slot refusal and never waits", async () => {
  const r = freeRig();
  let release;
  const running = admitThen(r.gate, () => new Promise((resolve) => { release = () => resolve("done"); }));
  let calls = 0;
  const refused = await admitThen(r.gate, async () => { calls += 1; });
  assert.deepEqual(refused, { ok: false, code: "gpu-busy", source: "slot" });
  assert.equal(calls, 0);
  const third = await admitThen(r.gate, async () => { calls += 1; });
  assert.equal(third.source, "slot");
  release();
  assert.equal(await running, "done");
  assert.equal(await admitThen(r.gate, async () => "next"), "next", "the slot frees when the job ends");
});

test("slot: a failing job still frees the slot", async () => {
  const r = freeRig();
  await assert.rejects(admitThen(r.gate, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await admitThen(r.gate, async () => "after"), "after");
});

test("slot: the household's answer comes before the slot's", async () => {
  const r = freeRig();
  const running = admitThen(r.gate, () => new Promise(() => {}));
  r.feed({ ...OWN, quns: 3 });
  const refused = await admitThen(r.gate, async () => {});
  assert.equal(refused.source, "admission");
  assert.equal(refused.gpu.inUse, true);
  void running;
});

test("own VRAM: a sequential batch of misses is never refused for Vili's own load", async () => {
  const r = freeRig();
  for (let miss = 1; miss <= 8; miss += 1) {
    const result = await admitThen(r.gate, async () => {
      for (let i = 0; i < 9; i += 1) r.feed(OWN); // about 2 minutes of child VRAM
      return `miss ${miss}`;
    });
    assert.equal(result, `miss ${miss}`, `miss ${miss} was admitted`);
    r.feed(CLEAR); // the child's VRAM has drained
    assert.equal(r.gate.status().inUse, false, `gate free after miss ${miss}`);
  }
});

test("own VRAM: the next request right after a job is admitted while the child's VRAM drains", async () => {
  const r = freeRig();
  await admitThen(r.gate, async () => { r.feed(OWN); r.feed(OWN); });
  r.feed(OWN); // still draining after the slot freed
  assert.equal(r.gate.status().inUse, false);
  const second = await admitThen(r.gate, async () => {
    r.feed(OWN);
    return "second";
  });
  assert.equal(second, "second");
  r.feed(CLEAR);
  assert.equal(r.gate.status().inUse, false, "the baseline survives back-to-back jobs, so recovery is judged against the first");
});

test("own VRAM: low VRAM that outlives the drain is the household's, and refuses", async () => {
  const r = freeRig({ sampleIntervalMs: 15 * SEC });
  await admitThen(r.gate, async () => { r.feed(OWN); });
  for (let i = 0; i < 3; i += 1) {
    r.feed(OWN);
    assert.equal(r.gate.status().inUse, false, `draining ${i}`);
  }
  r.feed(OWN); // 60 s after the release: the drain cap
  assert.equal(r.gate.status().inUse, true);
  assert.equal((await admitThen(r.gate, async () => {})).source, "admission");
});

test("own VRAM: partial recovery within the tolerance ends the drain, below it does not", async () => {
  const within = freeRig();
  await admitThen(within.gate, async () => { within.feed(OWN); });
  within.feed({ ...CLEAR, freeMiB: 14000 - 1024 });
  within.feed({ ...CLEAR, freeMiB: 5000 });
  assert.equal(within.gate.status().inUse, true, "recovered, then VRAM below the minimum counts again");

  const below = freeRig();
  await admitThen(below.gate, async () => { below.feed(OWN); });
  below.feed({ ...CLEAR, freeMiB: 14000 - 1025 });
  below.feed({ ...CLEAR, freeMiB: 5000 });
  assert.equal(below.gate.status().inUse, false, "still draining: not recovered to within the tolerance");
});

test("household signals mid-job count, and the next job is refused", async () => {
  for (const [name, sample] of [
    ["full-screen", { ...OWN, quns: 2 }],
    ["exclusive full-screen", { ...OWN, quns: 3 }],
  ]) {
    const r = freeRig();
    await admitThen(r.gate, async () => {
      r.feed(OWN);
      r.feed(sample);
    });
    const refused = await admitThen(r.gate, async () => {});
    assert.equal(refused.code, "gpu-busy", name);
    assert.equal(refused.source, "admission", name);
  }
  const sustained = freeRig();
  await admitThen(sustained.gate, async () => {
    sustained.feed({ ...OWN, util3d: 90 });
    sustained.feed({ ...OWN, util3d: 90 });
  });
  assert.equal((await admitThen(sustained.gate, async () => {})).source, "admission", "sustained 3D mid-job");
});

test("household VRAM that arrives mid-job is still there when the drain ends", async () => {
  const r = freeRig();
  await admitThen(r.gate, async () => { r.feed(OWN); });
  for (let i = 0; i < 4; i += 1) r.feed({ ...OWN, freeMiB: 600 });
  assert.equal(r.gate.status().inUse, true);
  assert.equal((await admitThen(r.gate, async () => {})).source, "admission");
});

// ---- the sample that cannot see the 3D engine ----

test("a sample with no resolved 3D counters is a probe fault, not a clear sample", () => {
  const r = rig();
  for (let i = 0; i < 20; i += 1) r.feed({ ...CLEAR, engines: 0 });
  assert.deepEqual(r.gate.status(), { inUse: true, since: r.t0, checkedAt: null, probeOk: false });
  r.feed({ ...CLEAR, engines: 1 });
  assert.equal(r.gate.status().checkedAt, r.at(), "one resolved counter is enough");
});

// ---- operator overrides ----

test("env overrides: valid values are read, absent ones are left to the defaults", () => {
  assert.deepEqual(gpuTenancyOptionsFromEnv({}), {});
  assert.deepEqual(gpuTenancyOptionsFromEnv({
    VILI_GPU_SAMPLE_MS: "5000",
    VILI_GPU_CLEAR_HOLD_MS: "0",
    VILI_GPU_MIN_FREE_MIB: "8192.5",
    VILI_GPU_UTIL3D_BUSY_PCT: "35",
  }), { sampleIntervalMs: 5000, clearHoldMs: 0, minFreeMiB: 8192.5, util3dBusyPct: 35 });
});

test("env overrides: a malformed value refuses to start and names the variable, not the value", () => {
  for (const name of ["VILI_GPU_SAMPLE_MS", "VILI_GPU_CLEAR_HOLD_MS", "VILI_GPU_MIN_FREE_MIB", "VILI_GPU_UTIL3D_BUSY_PCT"]) {
    for (const bad of ["10240MiB", "", "  ", "NaN", "Infinity", "-5"]) {
      assert.throws(
        () => gpuTenancyOptionsFromEnv({ [name]: bad }),
        (error) => error.message.includes(name) && (bad.trim() === "" || !error.message.includes(bad)),
        `${name}=${JSON.stringify(bad)}`,
      );
    }
  }
  assert.throws(() => gpuTenancyOptionsFromEnv({ VILI_GPU_SAMPLE_MS: "0" }), /VILI_GPU_SAMPLE_MS/, "a zero interval would spin the probe");
  assert.doesNotThrow(() => gpuTenancyOptionsFromEnv({ VILI_GPU_CLEAR_HOLD_MS: "0" }));
});
