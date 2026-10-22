// GPU tenancy gate: the one owner of "may heavy GPU work start now". It reads numbers only
// (full-screen state, 3D-engine use, host free VRAM), keeps a yes/no and a timestamp, and never
// learns which program is running. It refuses new work; it never stops work.
//
// The daemon holds one GPU slot. A job takes the slot through acquire() and the gate judges at that
// moment: the household signals say no, or another job holds the slot, and the answer is a typed
// refusal. Nothing waits. While Vili's own job holds the slot, and until its VRAM has drained after
// the slot frees, the free-VRAM signal is not the household's: the encoder child sizes itself to the
// VRAM that was free, so no VRAM sample separates Vili from a game. Full-screen and 3D-engine use
// always count.

export const RETRY_AFTER_SECONDS = 60;
const QUNS_BUSY = 2;
const QUNS_RUNNING_D3D_FULL_SCREEN = 3;

export function createGpuTenancy({
  now,
  sampleIntervalMs = 15000,
  clearHoldMs = 180000,
  minFreeMiB = 10240,
  util3dBusyPct = 20,
  staleAfterMs = 3 * sampleIntervalMs,
  drainToleranceMiB = 1024,
  drainCapMs = 4 * sampleIntervalMs,
}) {
  const startedAt = now();
  let inUse = true;
  let since = startedAt;
  let checkedAt = null;
  let lastSeenAt = startedAt;
  let clearSince = null;
  let previousUtil3d = null;
  let lastFreeMiB = null;
  let held = false;
  let baselineFreeMiB = null;
  let drainingSince = null;

  const staleSince = () => (now() - lastSeenAt > staleAfterMs ? lastSeenAt + staleAfterMs : null);

  function observe(sample) {
    // A probe that found no 3D engine counters is blind to the signal: a probe fault, not a clear
    // sample. The sample is dropped, the gate goes stale and fails closed.
    if (!(sample.engines >= 1)) return;
    const t = now();
    const staleAt = staleSince();
    if (staleAt !== null) {
      if (!inUse) {
        inUse = true;
        since = staleAt;
      }
      clearSince = null;
      previousUtil3d = null;
    }
    if (drainingSince !== null && (sample.freeMiB >= baselineFreeMiB - drainToleranceMiB || t - drainingSince >= drainCapMs)) {
      drainingSince = null;
    }
    const ownVram = held || drainingSince !== null;
    const sustained3d = sample.util3d > util3dBusyPct && previousUtil3d !== null && previousUtil3d > util3dBusyPct;
    const busy = sample.quns === QUNS_BUSY
      || sample.quns === QUNS_RUNNING_D3D_FULL_SCREEN
      || (!ownVram && sample.freeMiB < minFreeMiB)
      || sustained3d;
    previousUtil3d = sample.util3d;
    lastFreeMiB = sample.freeMiB;
    lastSeenAt = t;
    checkedAt = t;
    if (busy) {
      clearSince = null;
      if (!inUse) {
        inUse = true;
        since = t;
      }
      return;
    }
    if (clearSince === null) clearSince = t;
    if (inUse && t - clearSince >= clearHoldMs) {
      inUse = false;
      since = t;
    }
  }

  function status() {
    const staleAt = staleSince();
    if (staleAt !== null) {
      return { inUse: true, since: inUse ? since : staleAt, checkedAt, probeOk: false };
    }
    return { inUse, since, checkedAt, probeOk: true };
  }

  // Judges once and either takes the slot or answers the typed refusal. The household's answer comes
  // first: it is the one a consumer can act on.
  function acquire() {
    const gpu = status();
    if (gpu.inUse) return { refusal: { ok: false, code: "gpu-busy", source: "admission", gpu } };
    if (held) return { refusal: { ok: false, code: "gpu-busy", source: "slot" } };
    held = true;
    if (drainingSince === null) baselineFreeMiB = lastFreeMiB;
    return {
      release() {
        if (!held) return;
        held = false;
        drainingSince = now();
      },
    };
  }

  return { observe, status, acquire };
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

const ENV_OPTIONS = [
  ["VILI_GPU_SAMPLE_MS", "sampleIntervalMs", true],
  ["VILI_GPU_CLEAR_HOLD_MS", "clearHoldMs", false],
  ["VILI_GPU_MIN_FREE_MIB", "minFreeMiB", false],
  ["VILI_GPU_UTIL3D_BUSY_PCT", "util3dBusyPct", false],
];

// Operator overrides. A malformed value would silently defeat a comparison (NaN is never below
// anything), so it refuses to start instead, naming the variable and never its value.
export function gpuTenancyOptionsFromEnv(env) {
  const options = {};
  for (const [name, key, positive] of ENV_OPTIONS) {
    const raw = env[name];
    if (raw === undefined) continue;
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) {
      throw new Error(`${name} must be a finite ${positive ? "positive" : "non-negative"} number`);
    }
    options[key] = value;
  }
  return options;
}
