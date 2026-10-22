import assert from "node:assert/strict";
import test from "node:test";
import { admitThen, createGpuTenancy, gpuTenancyOptionsFromEnv, placementRefusal } from "./gpu-tenancy.mjs";

test("slot: a second request while a job runs is refused as a slot refusal and never waits", async () => {
  const gate = createGpuTenancy();
  let release;
  const running = admitThen(gate, () => new Promise((resolve) => { release = () => resolve("done"); }));
  let calls = 0;
  const refused = await admitThen(gate, async () => { calls += 1; });
  assert.deepEqual(refused, { ok: false, code: "gpu-busy", source: "slot" });
  assert.equal(calls, 0);
  release();
  assert.equal(await running, "done");
  assert.equal(await admitThen(gate, async () => "next"), "next", "the slot frees when the job ends");
});

test("slot: a failing job still frees the slot", async () => {
  const gate = createGpuTenancy();
  await assert.rejects(admitThen(gate, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await admitThen(gate, async () => "after"), "after");
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
