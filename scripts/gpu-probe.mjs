// The sample source for the GPU tenancy gate: one long-lived hidden PowerShell child in the daemon's
// own session. It decides nothing; it only turns the child's stdout into samples and keeps the child
// alive.

// The 3D-engine counter the probe reads. A wrong path reads as zero without an error, so the path is
// one constant, pinned by a test, and the probe reports how many engine counters it resolved.
export const UTIL3D_COUNTER_PATH = String.raw`\GPU Engine(*engtype_3D)\Utilization Percentage`;

// A probe line is JSON; only the four finite numbers survive, so nothing else can reach the gate.
export function parseSample(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { quns, freeMiB, util3d, engines } = value;
  for (const field of [quns, freeMiB, util3d, engines]) {
    if (typeof field !== "number" || !Number.isFinite(field)) return null;
  }
  return { quns, freeMiB, util3d, engines };
}

// The child exits with the daemon (the script watches the parent pid). If it exits on its own it is
// respawned at most once per interval. A child that stays alive but sends no sample for staleIntervals
// intervals is hung: it is killed and respawned the same way.
export function startProbe({ spawn, scriptPath, intervalMs, onSample, parentPid = process.pid, staleIntervals = 3 }) {
  let stopped = false;
  let lastSpawnAt = 0;
  let lastSampleAt = 0;
  let current = null;

  function scheduleRespawn(entry) {
    if (entry.respawned) return;
    entry.respawned = true;
    if (current === entry) current = null;
    setTimeout(launch, Math.max(0, lastSpawnAt + intervalMs - Date.now())).unref();
  }

  function launch() {
    if (stopped) return;
    lastSpawnAt = Date.now();
    lastSampleAt = lastSpawnAt;
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-ParentPid", String(parentPid),
      "-IntervalMs", String(intervalMs),
      "-Util3dPath", UTIL3D_COUNTER_PATH,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const entry = { child, respawned: false };
    current = entry;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const sample = parseSample(line.trim());
        if (sample) {
          lastSampleAt = Date.now();
          onSample(sample);
        }
      }
    });
    child.on("exit", () => scheduleRespawn(entry));
    child.on("error", () => scheduleRespawn(entry));
  }

  const watchdog = setInterval(() => {
    if (stopped || current === null || Date.now() - lastSampleAt <= staleIntervals * intervalMs) return;
    const hung = current;
    scheduleRespawn(hung);
    hung.child.kill();
  }, intervalMs);
  watchdog.unref();

  launch();
  return { stop: () => { stopped = true; clearInterval(watchdog); } };
}
