import assert from "node:assert/strict";
import test from "node:test";
import { admitThen, createGpuTenancy, gpuTenancyOptionsFromEnv, parseFreeMiB, placementRefusal } from "./gpu-tenancy.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Fake ports: a clock, a store spy and a free-VRAM source. No GPU, no daemon, no cache.
function rig({ permission, free = 12000, minFreeMiB } = {}) {
  const r = { t: Date.parse("2026-10-23T10:00:00Z"), saved: [], reads: 0, free, failSave: false };
  r.gate = createGpuTenancy({
    now: () => r.t,
    permission,
    minFreeMiB,
    savePermission: async (value) => {
      if (r.failSave) throw new Error("disk full");
      r.saved.push(value);
    },
    readFreeMiB: async () => {
      r.reads += 1;
      if (typeof r.free === "function") return r.free();
      return r.free;
    },
  });
  return r;
}
const ON = { allowed: true, changedAt: "2026-10-23T09:00:00.000Z" };

test("gate: toggle off refuses and creates no job", async () => {
  const r = rig();
  let calls = 0;
  const refused = await admitThen(r.gate, async () => { calls += 1; });
  assert.deepEqual(refused, { ok: false, code: "gpu-busy", source: "household", gpu: { allowed: false, changedAt: null } });
  assert.equal(calls, 0);
  assert.equal(r.reads, 0, "the VRAM is never read for a household refusal");
  assert.deepEqual(r.gate.status(), {
    allowed: false,
    changedAt: null,
    jobRunning: false,
    lastRefusal: { at: "2026-10-23T10:00:00.000Z", source: "household" },
  });
});

test("gate: toggle on admits", async () => {
  const r = rig({ permission: ON });
  let calls = 0;
  const result = await admitThen(r.gate, async () => {
    calls += 1;
    assert.equal(r.gate.status().jobRunning, true);
    return { ok: true, value: "finished" };
  });
  assert.deepEqual(result, { ok: true, value: "finished" });
  assert.equal(calls, 1);
  assert.equal(r.gate.status().jobRunning, false);
  assert.equal(r.gate.status().lastRefusal, null);
});

test("gate: toggle off mid-job lets the job finish and refuses the next", async () => {
  const r = rig({ permission: ON });
  const end = deferred();
  const running = admitThen(r.gate, async () => { await end.promise; return { ok: true, value: "finished" }; });
  while (!r.gate.status().jobRunning) await new Promise((resolve) => setImmediate(resolve));
  const off = await r.gate.setAllowed(false);
  assert.equal(off.allowed, false);
  assert.equal(off.jobRunning, true, "the job is still running");
  let calls = 0;
  const next = await admitThen(r.gate, async () => { calls += 1; });
  assert.equal(next.source, "household");
  assert.equal(calls, 0);
  end.resolve();
  assert.deepEqual(await running, { ok: true, value: "finished" });
  assert.equal(r.gate.status().jobRunning, false);
});

test("gate: the concurrent slot behaves as h2's did", async () => {
  const vram = deferred();
  const r = rig({ permission: ON, free: () => vram.promise });
  const end = deferred();
  let calls = 0;
  const job = async () => { calls += 1; await end.promise; return "done"; };
  const all = [admitThen(r.gate, job), admitThen(r.gate, job), admitThen(r.gate, job)];
  // the two losers are decided before the VRAM read resolves
  const losers = await Promise.all([all[1], all[2]]);
  assert.deepEqual(losers, [{ ok: false, code: "gpu-busy", source: "slot" }, { ok: false, code: "gpu-busy", source: "slot" }]);
  assert.equal(r.reads, 1, "only the slot holder reads VRAM");
  vram.resolve(12000);
  end.resolve();
  assert.equal(await all[0], "done");
  assert.equal(calls, 1);
  assert.equal(r.gate.status().jobRunning, false);

  await assert.rejects(admitThen(r.gate, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(r.gate.status().jobRunning, false, "a throwing job frees the slot");
  r.free = 100;
  assert.equal((await admitThen(r.gate, async () => "x")).source, "vram");
  const readsBefore = r.reads;
  r.free = 12000;
  assert.equal(await admitThen(r.gate, async () => "again"), "again", "a vram refusal frees the slot");
  assert.equal(r.reads, readsBefore + 1, "the next admission reads VRAM again");
});

test("gate: VRAM read fails closed", async () => {
  const cases = [[9000, 9000], [10239, 10239], [null, null], [Number.NaN, null], [() => { throw new Error("smi"); }, null]];
  for (const [free, expected] of cases) {
    const r = rig({ permission: ON, free });
    let calls = 0;
    const refused = await admitThen(r.gate, async () => { calls += 1; });
    assert.deepEqual(refused, { ok: false, code: "gpu-busy", source: "vram", freeMiB: expected, minFreeMiB: 10240 });
    assert.equal(calls, 0);
    assert.equal(r.gate.status().jobRunning, false);
    assert.equal(r.gate.status().lastRefusal.source, "vram");
  }
  const edge = rig({ permission: ON, free: 10240 });
  assert.equal(await admitThen(edge.gate, async () => "in"), "in", "exactly the minimum admits");
  const custom = rig({ permission: ON, free: 5000, minFreeMiB: 4096 });
  assert.equal(await admitThen(custom.gate, async () => "in"), "in", "the minimum is the configured one");
});

test("gate: a toggle during the VRAM read wins", async () => {
  const vram = deferred();
  const r = rig({ permission: ON, free: () => vram.promise });
  let calls = 0;
  const pending = admitThen(r.gate, async () => { calls += 1; });
  await r.gate.setAllowed(false);
  vram.resolve(12000);
  const refused = await pending;
  assert.equal(refused.source, "household");
  assert.equal(calls, 0);
  assert.equal(r.gate.status().jobRunning, false);
});

test("gate: setAllowed saves before it answers", async () => {
  const r = rig();
  r.failSave = true;
  await assert.rejects(r.gate.setAllowed(true), /disk full/);
  assert.equal(r.gate.status().allowed, false, "a failed save leaves the state unchanged");
  assert.equal(r.gate.status().changedAt, null);
  r.failSave = false;

  await assert.rejects(r.gate.setAllowed("yes"), TypeError);
  await assert.rejects(r.gate.setAllowed(undefined), TypeError);
  assert.deepEqual(r.saved, [], "a non-boolean saves nothing");

  r.t += 1000;
  const on = await r.gate.setAllowed(true);
  assert.deepEqual(r.saved, [{ allowed: true, changedAt: "2026-10-23T10:00:01.000Z" }]);
  assert.equal(on.allowed, true);
  assert.equal(on.changedAt, "2026-10-23T10:00:01.000Z");

  r.t += 5000;
  const same = await r.gate.setAllowed(true);
  assert.equal(r.saved.length, 1, "a same-value call saves nothing");
  assert.equal(same.changedAt, "2026-10-23T10:00:01.000Z", "and keeps changedAt");
});

test("gate: a second release is a no-op and cannot free another job's slot", async () => {
  const r = rig({ permission: ON });
  const first = await r.gate.acquire();
  first.release();
  const second = await r.gate.acquire();
  assert.equal(r.gate.status().jobRunning, true);
  first.release();
  assert.equal(r.gate.status().jobRunning, true, "a stale release leaves the new holder's slot held");
  assert.equal((await r.gate.acquire()).refusal.source, "slot");
  second.release();
  second.release();
  assert.equal(r.gate.status().jobRunning, false);
  assert.equal(typeof (await r.gate.acquire()).release, "function", "the slot is free after the real release");
});

test("gate: a stored permission is the starting state", () => {
  assert.deepEqual(rig({ permission: ON }).gate.status(), { allowed: true, changedAt: ON.changedAt, jobRunning: false, lastRefusal: null });
  assert.equal(rig({ permission: { allowed: "yes", changedAt: "x" } }).gate.status().allowed, false, "only a true boolean allows");
});

test("parseFreeMiB reads the first line as a base-10 integer", () => {
  assert.equal(parseFreeMiB("5001\r\n"), 5001);
  assert.equal(parseFreeMiB("0"), 0);
  assert.equal(parseFreeMiB(" 12 \n7\n"), 12);
  for (const bad of ["", "[N/A]", "abc", "-5", "1e3", "12.5", "12 MiB", "\n5", null, undefined]) {
    assert.equal(parseFreeMiB(bad), null, JSON.stringify(bad));
  }
});

test("placement refusal is keyed on the typed code, never on text, and carries no gate status", () => {
  assert.deepEqual(placementRefusal({ ok: false, code: "gpu-busy", error: "x" }, "vili-1"), {
    ok: false, code: "gpu-busy", source: "placement", jobId: "vili-1",
  });
  assert.equal(placementRefusal({ ok: false, error: "gpu-busy: 0.50 GiB of VRAM free" }, "vili-1"), null);
  assert.equal(placementRefusal({ ok: false, code: null }, "vili-1"), null);
  assert.equal(placementRefusal(null, "vili-1"), null);
});

test("env override: a valid value is read, absent is left to the default", () => {
  assert.deepEqual(gpuTenancyOptionsFromEnv({}), {});
  assert.deepEqual(gpuTenancyOptionsFromEnv({ VILI_GPU_MIN_FREE_MIB: "8192.5" }), { minFreeMiB: 8192.5 });
  assert.deepEqual(gpuTenancyOptionsFromEnv({ VILI_GPU_MIN_FREE_MIB: "0" }), { minFreeMiB: 0 });
});

test("env override: a malformed value refuses to start and names the variable, not the value", () => {
  for (const bad of ["10240MiB", "", "  ", "NaN", "Infinity", "-5"]) {
    assert.throws(
      () => gpuTenancyOptionsFromEnv({ VILI_GPU_MIN_FREE_MIB: bad }),
      (error) => error.message === "VILI_GPU_MIN_FREE_MIB must be a finite non-negative number",
      JSON.stringify(bad),
    );
  }
});
