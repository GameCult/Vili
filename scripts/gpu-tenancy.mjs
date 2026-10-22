// GPU tenancy gate: the one owner of "may heavy GPU work start now". The household decides, through
// the permission it sets at the tray; the daemon owns that yes or no, the one GPU slot, and one host
// free-VRAM read per admission. The gate refuses new work; it never stops work.
//
// acquire() judges in a fixed order and nothing waits: the permission, then the slot, then host free
// VRAM. The slot is taken before the VRAM read so concurrent requests are refused at once.

export const RETRY_AFTER_SECONDS = 60;

export function createGpuTenancy({ now, permission, savePermission, readFreeMiB, minFreeMiB = 10240 }) {
  let allowed = permission?.allowed === true;
  let changedAt = permission?.changedAt ?? null;
  let held = false;
  let lastRefusal = null;

  const status = () => ({ allowed, changedAt, jobRunning: held, lastRefusal });

  function refuse(source, extra = {}) {
    lastRefusal = { at: new Date(now()).toISOString(), source };
    return { refusal: { ok: false, code: "gpu-busy", source, ...extra } };
  }
  const household = () => refuse("household", { gpu: { allowed: false, changedAt } });

  async function setAllowed(next) {
    if (typeof next !== "boolean") throw new TypeError("allowed must be a boolean");
    if (next === allowed) return status();
    const value = { allowed: next, changedAt: new Date(now()).toISOString() };
    await savePermission(value);
    allowed = value.allowed;
    changedAt = value.changedAt;
    return status();
  }

  async function acquire() {
    if (!allowed) return household();
    if (held) return refuse("slot");
    held = true;
    let freeMiB;
    try {
      freeMiB = await readFreeMiB();
    } catch {
      freeMiB = null;
    }
    if (!allowed) {
      held = false;
      return household();
    }
    if (!Number.isFinite(freeMiB) || freeMiB < minFreeMiB) {
      held = false;
      return refuse("vram", { freeMiB: Number.isFinite(freeMiB) ? freeMiB : null, minFreeMiB });
    }
    return {
      release() {
        held = false;
      },
    };
  }

  return { status, setAllowed, acquire };
}

// Takes the slot, runs the job to its end and returns its result, or returns the typed refusal
// without calling the job. The gate never holds, pauses or cancels a job.
export async function admitThen(gate, job) {
  const slot = await gate.acquire();
  if (slot.refusal) return slot.refusal;
  try {
    return await job();
  } finally {
    slot.release();
  }
}

// nvidia-smi's first line is the free MiB as a base-10 integer; anything else is null.
export function parseFreeMiB(stdout) {
  const line = String(stdout).split("\n")[0].trim();
  return /^\d+$/.test(line) ? Number(line) : null;
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
