// GPU tenancy gate. The detection of the household's use is deleted; this file holds the one GPU
// slot only, until the household's permission lands. It refuses new work and never stops work.

export const RETRY_AFTER_SECONDS = 60;

export function createGpuTenancy({ minFreeMiB = 10240 } = {}) {
  let held = false;
  return {
    status: () => ({ jobRunning: held, minFreeMiB }),
    acquire() {
      if (held) return { refusal: { ok: false, code: "gpu-busy", source: "slot" } };
      held = true;
      return {
        release() {
          held = false;
        },
      };
    },
  };
}

// Takes the slot, runs the job to its end and returns its result, or returns the typed refusal
// without calling the job. The gate never holds, pauses or cancels a job.
export async function admitThen(gate, job) {
  const slot = gate.acquire();
  if (slot.refusal) return slot.refusal;
  try {
    return await job();
  } finally {
    slot.release();
  }
}

// The encoder child's placement refusal reaches the daemon as a typed code on the worker's error body;
// it is never read out of error text. Placement is the child's own view of free VRAM, not the
// household gate, so the body carries no gate status. Returns the typed 503 body, or null for any
// other outcome.
export function placementRefusal(workerBody, jobId) {
  if (workerBody?.code !== "gpu-busy") return null;
  return { ok: false, code: "gpu-busy", source: "placement", jobId };
}

// Operator override. A malformed value would silently defeat a comparison (NaN is never below
// anything), so it refuses to start instead, naming the variable and never its value.
export function gpuTenancyOptionsFromEnv(env) {
  const options = {};
  const raw = env.VILI_GPU_MIN_FREE_MIB;
  if (raw !== undefined) {
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error("VILI_GPU_MIN_FREE_MIB must be a finite non-negative number");
    options.minFreeMiB = value;
  }
  return options;
}
