// GPU tenancy gate: the one owner of "may heavy GPU work start now", from the host's view.
// It reads numbers only (full-screen state, 3D-engine use, host free VRAM), keeps a yes/no and a
// timestamp, and never learns which program is running. It refuses new work; it never stops work.

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
}) {
  const startedAt = now();
  let inUse = true;
  let since = startedAt;
  let checkedAt = null;
  let lastSeenAt = startedAt;
  let clearSince = null;
  let previousUtil3d = null;

  const staleSince = () => (now() - lastSeenAt > staleAfterMs ? lastSeenAt + staleAfterMs : null);

  function observe(sample) {
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
    const sustained3d = sample.util3d > util3dBusyPct && previousUtil3d !== null && previousUtil3d > util3dBusyPct;
    const busy = sample.quns === QUNS_BUSY
      || sample.quns === QUNS_RUNNING_D3D_FULL_SCREEN
      || sample.freeMiB < minFreeMiB
      || sustained3d;
    previousUtil3d = sample.util3d;
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

  return { observe, status };
}

// A probe line is JSON; only the three finite numbers survive, so nothing else can reach the gate.
export function parseSample(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { quns, freeMiB, util3d } = value;
  for (const field of [quns, freeMiB, util3d]) {
    if (typeof field !== "number" || !Number.isFinite(field)) return null;
  }
  return { quns, freeMiB, util3d };
}

// Checks the gate once. A busy gate refuses without calling the job; a free gate runs the job to
// its end and returns its result: the gate never holds, pauses or cancels a job.
export async function admitThen(gate, job) {
  const gpu = gate.status();
  if (gpu.inUse) return { ok: false, code: "gpu-busy", source: "admission", gpu };
  return job();
}

// The encoder child's placement refusal reaches the daemon as a typed code on the worker's error body;
// it is never read out of error text. Returns the typed 503 body, or null for any other outcome.
export function placementRefusal(workerBody, gpu, jobId) {
  if (workerBody?.code !== "gpu-busy") return null;
  return { ok: false, code: "gpu-busy", source: "placement", gpu, jobId };
}

// One long-lived hidden PowerShell child feeds samples. It exits with the daemon (the script watches
// the parent pid); if it exits on its own it is respawned at most once per interval.
export function startProbe({ spawn, scriptPath, intervalMs, onSample, parentPid = process.pid }) {
  let stopped = false;
  let lastSpawnAt = 0;

  function launch() {
    if (stopped) return;
    lastSpawnAt = Date.now();
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-ParentPid", String(parentPid),
      "-IntervalMs", String(intervalMs),
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const sample = parseSample(line.trim());
        if (sample) onSample(sample);
      }
    });
    let respawned = false;
    const respawn = () => {
      if (respawned) return;
      respawned = true;
      setTimeout(launch, Math.max(0, lastSpawnAt + intervalMs - Date.now())).unref();
    };
    child.on("exit", respawn);
    child.on("error", respawn);
  }

  launch();
  return { stop: () => { stopped = true; } };
}
