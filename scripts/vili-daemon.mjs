#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentRegistry,
  defineDocumentType,
} = require("@gamecult/cultcache-ts");
const projectRoot = path.resolve(__dirname, "..");
const providerId = "vili.animation";
const viliStoreFileName = "vili.service.cc";
const objectSchema = { parse: (value) => value };
const operatorStateDefinition = defineDocumentType({
  type: "gamecult.vili.operator_state",
  schemaName: "gamecult.vili.operator_state",
  schemaId: "gamecult.vili.operator_state.v1",
  schemaVersion: "gamecult.vili.operator_state.v1",
  name: (value) => value?.service || "vili",
  schema: objectSchema,
  members: [
    { slot: 0, memberName: "service", typeName: "string", isName: true },
    { slot: 1, memberName: "providerId", typeName: "string" },
    { slot: 2, memberName: "updatedAt", typeName: "string" },
    { slot: 3, memberName: "backend", typeName: "object" },
  ],
});
const commandBoundaryDefinition = defineDocumentType({
  type: "gamecult.vili.command_boundary",
  schemaName: "gamecult.vili.command_boundary",
  schemaId: "gamecult.vili.command_boundary.v1",
  schemaVersion: "gamecult.vili.command_boundary.v1",
  name: (value) => value?.boundaryId || "vili",
  schema: objectSchema,
  members: [
    { slot: 0, memberName: "boundaryId", typeName: "string", isName: true },
    { slot: 1, memberName: "owner", typeName: "string" },
    { slot: 2, memberName: "commandAuthority", typeName: "object" },
    { slot: 3, memberName: "forbiddenAuthority", typeName: "string" },
    { slot: 4, memberName: "updatedAt", typeName: "string" },
  ],
});
const transportProfileDefinition = defineDocumentType({
  type: "gamecult.vili.transport_profile",
  schemaName: "gamecult.vili.transport_profile",
  schemaId: "gamecult.vili.transport_profile.v1",
  schemaVersion: "gamecult.vili.transport_profile.v1",
  name: (value) => value?.profileId || "vili",
  schema: objectSchema,
  members: [
    { slot: 0, memberName: "profileId", typeName: "string", isName: true },
    { slot: 1, memberName: "daemonId", typeName: "string" },
    { slot: 2, memberName: "targetTransport", typeName: "string" },
    { slot: 3, memberName: "state", typeName: "string" },
    { slot: 4, memberName: "updatedAt", typeName: "string" },
  ],
});
const viliDocumentRegistry = defineDocumentRegistry(
  operatorStateDefinition,
  commandBoundaryDefinition,
  transportProfileDefinition,
);

const MAX_THREADS = 16;
const CLIP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// The state root's one identity: symlinks resolved as far as the path exists. The hand-run lock's name, reclaim's
// marker and the worker's environment all derive from args.stateRoot, so two spellings of one root are one root.
function canonicalPath(target) {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(canonicalPath(parent), path.basename(target));
  }
}

function parseArgs(argv) {
  const env = process.env;
  const args = {
    host: env.VILI_DAEMON_HOST || "127.0.0.1",
    port: Number(env.VILI_DAEMON_PORT || 8824),
    stateRoot: path.resolve(env.VILI_STATE_ROOT || path.join(projectRoot, ".vili")),
    python: env.VILI_PYTHON || "python3",
    workerEntry: path.resolve(env.VILI_WORKER_ENTRY || path.join(__dirname, "kimodo-resident-worker.py")),
    modelsRoot: env.VILI_MODELS_ROOT || "",
    threads: env.VILI_THREADS || "8",
    kimodoCommit: env.VILI_KIMODO_COMMIT || "",
    pythonEnv: env.VILI_PYTHON_ENV || "",
    blender: env.VILI_BLENDER || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--state-root") args.stateRoot = path.resolve(argv[++index]);
    else if (arg === "--python") args.python = argv[++index];
    else if (arg === "--worker-entry") args.workerEntry = path.resolve(argv[++index]);
    else if (arg === "--models-root") args.modelsRoot = argv[++index];
    else if (arg === "--threads") args.threads = argv[++index];
    else if (arg === "--kimodo-commit") args.kimodoCommit = argv[++index];
    else if (arg === "--python-env") args.pythonEnv = argv[++index];
    else if (arg === "--blender") args.blender = argv[++index];
  }
  if (!/^[0-9]{1,2}$/.test(String(args.threads)) || Number(args.threads) < 1 || Number(args.threads) > MAX_THREADS) {
    console.error(`threads must be an integer from 1 to ${MAX_THREADS}`);
    process.exit(2);
  }
  args.threads = Number(args.threads);
  args.stateRoot = canonicalPath(args.stateRoot);
  if (args.modelsRoot) args.modelsRoot = path.resolve(args.modelsRoot);
  if (args.blender) args.blender = path.resolve(args.blender);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();

// The rest pose Kimodo ships, in the worker interpreter's own tree (<python>/lib/python3.12/site-packages), once.
const restBvh = path.isAbsolute(args.python)
  ? path.join(path.dirname(path.dirname(args.python)), "lib", "python3.12", "site-packages", "kimodo", "assets", "skeletons", "somaskel77", "somaskel77_standard_tpose.bvh")
  : null;

// The worker child. Display state only: nothing reads `worker` to decide anything but ensureWorker.
const worker = { state: "stopped", proc: null, pid: null, port: null, servedModels: [], lastError: null };
let starting = null;

// Blender, probed once after the lease. Display and admission state: it decides only whether an fbx request is
// refused early. `version` is the first line of `blender --version`, or null (unconfigured, or the probe failed).
const blender = { version: null };
const blenderReady = () => blender.version !== null;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function boolValue(value) {
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}

function json(response, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function text(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

// A browser page can POST to localhost; a browser cannot send application/json cross-site without a preflight,
// and no route answers a preflight. So a POST that carries an Origin, or is not JSON, never reaches the body.
function refuseCrossSite(request, response) {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (request.headers.origin !== undefined || contentType !== "application/json") {
    json(response, 403, { ok: false, code: "cross-site" });
    return true;
  }
  return false;
}

function backendStatus() {
  return {
    state: worker.state,
    pid: worker.pid,
    port: worker.port,
    threads: args.threads,
    pythonEnv: args.pythonEnv || null,
    kimodoCommit: args.kimodoCommit || null,
    modelsRoot: args.modelsRoot || null,
    lastError: worker.lastError,
    blender: blender.version ?? (args.blender ? "unavailable" : "unconfigured"),
  };
}

function operatorState() {
  return {
    schema: "gamecult.vili.operator_state.v0",
    service: "vili",
    providerId,
    host: os.hostname(),
    startedAt,
    updatedAt: new Date().toISOString(),
    backend: backendStatus(),
    authority: {
      owns: [
        "animation job intake",
        "worker process lifecycle",
        "motion artifact references",
        "clip export to FBX",
      ],
      doesNotOwn: [
        "Persona speech generation",
        "Weksa interlingua lowering",
        "retargeting and playback",
        "Odin discovery truth",
      ],
    },
    routes: {
      health: "/health",
      operatorState: "/operator-state",
      generate: "/motion/generate",
      artifacts: "/motion/artifacts/{jobId}/{name}",
      restFbx: "/motion/rest-fbx",
    },
  };
}

function commandBoundary() {
  return {
    schema: "gamecult.vili.command_boundary.v1",
    boundaryId: "vili",
    daemonId: "vili",
    owner: "Vili animation runtime",
    updatedAt: new Date().toISOString(),
    commandAuthority: {
      intake: {
        method: "POST",
        path: "/motion/generate",
        owns: [
          "animation job identity",
          "request persistence",
          "worker process lifecycle",
          "timeout handling",
          "motion artifact references",
          "clip export",
        ],
      },
      restFbx: {
        method: "POST",
        path: "/motion/rest-fbx",
        owns: ["the rest-pose FBX job"],
      },
      artifacts: {
        method: "GET",
        path: "/motion/artifacts/{jobId}/{name}",
        owns: ["read-only artifact bytes"],
        doesNotOwn: ["any path outside the job's artifact directory"],
      },
      liveness: {
        method: "GET",
        path: "/health",
        owns: ["compatibility liveness witness"],
        doesNotOwn: [],
      },
    },
    forbiddenAuthority:
      "HTTP health and the operator-state projection are compatibility lowerings; they do not own daemon health or provider truth when CultCache/CultNet records exist.",
  };
}

function transportProfile() {
  return {
    schema: "gamecult.vili.transport_profile.v1",
    profileId: "vili",
    daemonId: "vili",
    targetTransport: "cultnet.transport.rudp.v0",
    currentTransport: "CultCache local state + compatibility HTTP lowerings",
    state: "local-cultcache-only",
    operatorStateSchema: "gamecult.vili.operator_state.v1",
    commandBoundarySchema: "gamecult.vili.command_boundary.v1",
    compatibilityMechanisms: ["/health", "/operator-state"],
    cutLine:
      "Vili owns typed operator, command, and transport state. HTTP projections are lowerings until Odin consumes Vili records over CultNet/RUDP.",
    updatedAt: new Date().toISOString(),
  };
}

async function persistSurfaces() {
  guard();
  await mkdir(args.stateRoot, { recursive: true });
  const cache = CultCache.builder()
    .withRegistry(viliDocumentRegistry)
    .withGenericStore(new SingleFileMessagePackBackingStore(path.join(args.stateRoot, viliStoreFileName)))
    .build();
  guard();
  await cache.put(operatorStateDefinition, "vili", operatorState());
  guard();
  await cache.put(commandBoundaryDefinition, "vili", commandBoundary());
  guard();
  await cache.put(transportProfileDefinition, "vili", transportProfile());
}

// The whole child environment, in one place. Nothing else from process.env reaches the worker.
function childEnv() {
  const threads = String(args.threads);
  const env = {
    HF_HOME: args.modelsRoot,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    VILI_EMBEDDINGS_DIR: path.join(args.stateRoot, "embeddings"),
    VILI_THREADS: threads,
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    PYTHONPATH: path.join(projectRoot, "vendor", "CultLib", "packages", "cultcache-py", "src"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    VILI_KIMODO_COMMIT: args.kimodoCommit,
    VILI_PYTHON_ENV: args.pythonEnv,
  };
  for (const name of ["PATH", "HOME", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

// The whole Blender environment, in one place: nothing else from process.env reaches it. The libraries the sealed
// release carries sit in blender/lib; PYTHONHASHSEED=0 is half of byte-reproducible export (scripts/bvh-to-fbx.py).
function exportEnv() {
  const env = {
    HOME: "/nonexistent",
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    LD_LIBRARY_PATH: path.join(path.dirname(args.blender), "lib"),
  };
  for (const name of ["PATH", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function workerUnconfigured() {
  return !args.modelsRoot || !args.kimodoCommit || !args.pythonEnv;
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// The worker leads its own process group (its pid is the group id), so the encoder child it spawns is in the group
// too. The daemon owns the whole group: it is killed when the worker exits for any reason and on a requested stop.
// A crashed hand-run daemon's group is reclaimed by the next hand-run daemon (handRunRuntime). Under Idunn the
// unit's cgroup is the same ownership from outside the process.
function killGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // no such group
  }
}

// The hand-run way of owning a state root (tests, development): a Unix socket lock, the worker's pid file and the
// /proc reclaim. Idunn's runtime (scripts/idunn-entry.mjs) replaces all three with its process write lease.
export function handRunRuntime(stateRoot) {
  const pidFile = path.join(stateRoot, "worker.pid");
  let lock = null;

  // The lock is a listening socket in Linux's abstract namespace, named by the state root, which is canonical (its real path, see canonicalPath). A bind is
  // atomic and exclusive and the kernel drops it with its owner, so there is no lock file, no stale lock to probe
  // or take over, and no takeover to race: a bind either succeeds (this daemon owns the root) or it does not.
  const listen = () => new Promise((resolve, reject) => {
    const name = createHash("sha256").update(stateRoot).digest("hex");
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(`\0vili-state-root:${name}`, () => {
      server.removeListener("error", reject);
      lock = server;
      resolve();
    });
  });

  // A worker left by a crashed daemon: the pid file names its group, and the group is ours only if some member
  // still carries this state root's embeddings directory in its environment (the pid may have been reused).
  function reclaimStrayWorker() {
    let pgid;
    try {
      pgid = Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      return;
    }
    const marker = `VILI_EMBEDDINGS_DIR=${path.join(stateRoot, "embeddings")}`;
    let ours = false;
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) !== pgid) continue;
          if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(marker)) ours = true;
        } catch {
          // the process exited while we looked
        }
      }
    } catch {
      // no /proc: nothing can be verified, so nothing is killed
    }
    if (ours) killGroup(pgid, "SIGKILL");
    try {
      unlinkSync(pidFile);
    } catch {
      // already gone
    }
  }

  return {
    async acquire() {
      await mkdir(stateRoot, { recursive: true });
      try {
        await listen();
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        console.error("the state root is held by a running daemon");
        process.exit(2);
      }
      reclaimStrayWorker(); // synchronous: no request is served before a predecessor's worker is gone
    },
    held: () => lock !== null,
    refusal: () => "write-lease-pending",
    watch() {},
    recordWorker(pid) {
      writeFileSync(pidFile, `${pid}\n`);
    },
    forgetWorker(pid) {
      try {
        if (readFileSync(pidFile, "utf8").trim() === String(pid)) unlinkSync(pidFile);
      } catch {
        // no pid file, or another worker's
      }
    },
    release() {
      if (lock) lock.close();
      lock = null;
    },
  };
}

// A requested stop gives a process group its grace (SIGTERM, then SIGKILL); a lost writer gets SIGKILL at once. The
// worker and the exports are stopped by this one path.
async function stopGroups(procs, signals) {
  for (const signal of signals) {
    for (const proc of procs) if (proc.pid !== undefined) killGroup(proc.pid, signal);
    const gone = await Promise.all(procs.map((proc) => waitForExit(proc, signal === "SIGTERM" ? 10000 : 5000)));
    if (gone.every(Boolean)) break;
  }
}

const STOP_SIGNALS = ["SIGTERM", "SIGKILL"];

async function stopWorker(signals = STOP_SIGNALS) {
  const proc = worker.proc;
  if (!proc || proc.pid === undefined) return;
  worker.state = "stopped";
  await stopGroups([proc], signals);
}

// Blender's process groups in flight. A finished export removes itself; a model switch (ensureWorker) leaves them alone.
const exportGroups = new Set();
const stopExports = (signals = STOP_SIGNALS) => stopGroups([...exportGroups], signals);

function isRegularFile(file) {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

// A regular file (no symlink, in the file or any directory above it) strictly inside `directory`, which is canonical.
function regularFileInside(file, directory) {
  const relative = path.relative(directory, file);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") return false;
  try {
    return lstatSync(file).isFile() && realpathSync(file) === file;
  } catch {
    return false;
  }
}

const exportScript = path.join(__dirname, "bvh-to-fbx.py");
// The state slot "work" (deployment/idunn/recipe.toml): one private directory per export, removed by the export itself
// and, if the daemon died mid-export, swept by the next daemon that holds the state root (sweepWork).
const WORK_DIR = "work";
const EXPORT_PREFIX = "export-";
const EXPORT_NAME = new RegExp(`^${EXPORT_PREFIX}[A-Za-z0-9]{6}$`);
const EXPORT_SETTINGS = "standard-tpose soma77 metres hashseed0 time1970";
const EXPORT_TIMEOUT_MS = 120000;
let exportScriptDigest = null;
const scriptDigest = () => (exportScriptDigest ??= `sha256:${createHash("sha256").update(readFileSync(exportScript)).digest("hex")}`);

// Runs the sealed Blender in its own process group, niced, under the write gate. Both streams go to
// logs/export.log line by line through mayWrite(), and only there; the version probe is not logged, so it writes
// nothing to the state root. Resolves { code, signal, first, result }: the exit, the first stdout line and the last
// `VILI-FBX ` line's payload. It rejects only with LeaseLost.
async function runBlender(argv, timeoutMs, logged = true) {
  guard();
  let sink = null;
  if (logged) {
    await mkdir(path.join(args.stateRoot, "logs"), { recursive: true });
    guard(); // synchronous with the log open and the spawn below: no await between them
    sink = openSync(path.join(args.stateRoot, "logs", "export.log"), "a");
  }
  const proc = spawn(args.blender, argv, {
    cwd: __dirname,
    env: exportEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: true,
  });
  exportGroups.add(proc);
  const seen = { first: null, result: null };
  let sinkOpen = sink !== null;
  for (const [stream, isStdout] of [[proc.stdout, true], [proc.stderr, false]]) {
    if (!stream) continue;
    readline.createInterface({ input: stream }).on("line", (line) => {
      if (isStdout) {
        seen.first ??= line;
        if (line.startsWith("VILI-FBX ")) seen.result = line.slice("VILI-FBX ".length);
      }
      if (sinkOpen && mayWrite()) writeSync(sink, `${line}\n`);
    });
  }
  const finished = new Promise((resolve) => {
    proc.once("error", () => resolve({ code: null, signal: null }));
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
  proc.once("exit", () => {
    exportGroups.delete(proc);
    if (proc.pid !== undefined) killGroup(proc.pid, "SIGKILL"); // whatever Blender left running
  });
  try {
    os.setPriority(proc.pid, 10);
  } catch {
    if (proc.pid !== undefined) killGroup(proc.pid, "SIGKILL");
  }
  const timer = setTimeout(() => {
    if (proc.pid !== undefined) killGroup(proc.pid, "SIGKILL");
  }, timeoutMs);
  const exit = await finished;
  clearTimeout(timer);
  exportGroups.delete(proc);
  if (sink !== null) closeSync(sink);
  sinkOpen = false;
  return { ...exit, ...seen };
}

// Blender answers once at start: `blender --version`, 15 s. Ready only when it exits 0 and names itself.
async function probeBlender() {
  if (!args.blender) return;
  const run = await runBlender(["-b", "--factory-startup", "--version"], 15000, false);
  guard();
  blender.version = run.code === 0 && run.first?.startsWith("Blender ") ? run.first : null;
}

// The bytes of a regular file strictly inside `directory`, or null. The file is opened without following a symlink
// and without blocking (a FIFO or a device would otherwise hold the open, and a filesystem thread, indefinitely), and
// the open file is the one checked, so a path swapped after the check cannot redirect the read.
async function readInside(file, directory) {
  let handle = null;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || !regularFileInside(file, directory)) return null;
    const named = lstatSync(file);
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// One BVH to one FBX beside it. Blender never sees a path in the job's artifact directory: it reads a private copy of
// the BVH and writes a private FBX in a directory made for this export alone, and the FBX is then created beside the
// BVH exclusively, so nothing planted at either path is read, written through or replaced. The FBX counts only if
// Blender exits 0, prints its result line and its file exists. A failure names the exit or the signal and never
// Blender's output.
async function exportClip(bvh, fbx, clipName, timeoutMs, artifactDir) {
  const input = await readInside(bvh, artifactDir);
  if (input === null) return { error: "fbx-export-refused" };
  guard();
  const work = await mkdtemp(path.join(args.stateRoot, WORK_DIR, EXPORT_PREFIX));
  try {
    const privateBvh = path.join(work, "in.bvh");
    const privateFbx = path.join(work, "out.fbx");
    guard();
    await writeFile(privateBvh, input, { flag: "wx" });
    const run = await runBlender([
      "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1",
      "--python", exportScript, "--", privateBvh, privateFbx, clipName,
    ], timeoutMs);
    let info = null;
    if (run.code === 0 && run.result !== null) {
      try {
        const parsed = JSON.parse(run.result);
        if (Number.isInteger(parsed.bones) && Array.isArray(parsed.frames) && parsed.frames.length === 2
          && parsed.frames.every(Number.isInteger) && Number.isFinite(parsed.fps)) info = parsed;
      } catch {
        // not the result line
      }
    }
    const made = info ? await readInside(privateFbx, work) : null;
    if (made !== null) {
      guard();
      try {
        await writeFile(fbx, made, { flag: "wx" });
        return { clip: { file: fbx, clipName, bones: info.bones, frames: info.frames, fps: info.fps } };
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        return { error: "fbx-export-refused" };
      }
    }
    const how = run.code === 0 ? "no result" : run.code !== null ? `exit ${run.code}` : `signal ${run.signal ?? "none"}`;
    return { error: `fbx-export-failed (${how})` };
  } finally {
    if (mayWrite()) await rm(work, { recursive: true, force: true });
  }
}

// The export directories a killed daemon left: only directories named as mkdtemp names them, only under work/. Called
// once, after the runtime holds the state root, so a live daemon's export is never swept.
async function sweepWork() {
  const root = path.join(args.stateRoot, WORK_DIR);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !EXPORT_NAME.test(entry.name)) continue;
    guard();
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}

// Every BVH the worker listed becomes an FBX, or the job fails. A listed BVH must be a regular file inside the job's
// artifact directory, and that is decided when its export begins (exportClip), never earlier. Sample N of several is
// <clipName>_NN.
async function exportListed(listed, artifactDir, clipName, timeoutMs) {
  const bvhs = [];
  for (const file of Array.isArray(listed) ? listed : []) {
    if (typeof file !== "string" || !file.endsWith(".bvh")) continue;
    bvhs.push(path.resolve(artifactDir, file));
  }
  if (bvhs.length === 0) return { clips: [], error: "fbx-export-failed (no bvh)" };
  bvhs.sort();
  const clips = [];
  for (const [index, bvh] of bvhs.entries()) {
    const name = bvhs.length === 1 ? clipName : `${clipName}_${String(index).padStart(2, "0")}`;
    const done = await exportClip(bvh, `${bvh.slice(0, -".bvh".length)}.fbx`, name, timeoutMs, artifactDir);
    if (done.error) return { clips, error: done.error };
    clips.push({ ...done.clip, file: path.relative(artifactDir, done.clip.file).split(path.sep).join("/") });
  }
  return { clips, error: null };
}

// Every regular file under the artifact directory, named relative to it, sorted.
async function artifactFiles(directory) {
  const files = [];
  const walk = async (relative) => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(directory, name));
        files.push({ name: name.split(path.sep).join("/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  };
  await walk("");
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The one job record, for a generate job and a rest job alike: what the job was, which files it left and, for an
// export, the exact Blender and script that made them.
async function writeJobRecord(job, exported) {
  guard();
  const record = { schema: "gamecult.vili.motion_job.v1", ...job, files: await artifactFiles(job.artifactDir) };
  if (exported) record.export = { blender: blender.version, script: scriptDigest(), settings: EXPORT_SETTINGS, clips: exported.clips };
  guard();
  await writeFile(path.join(args.stateRoot, "jobs", `${job.jobId}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function startWorker(model, timeoutMs) {
  guard();
  await mkdir(path.join(args.stateRoot, "logs"), { recursive: true });
  guard();
  await mkdir(path.join(args.stateRoot, "embeddings"), { recursive: true });
  guard(); // synchronous with the log open and the spawn below: no await between them
  const logFd = openSync(path.join(args.stateRoot, "logs", "worker.log"), "a");
  const argv = [args.workerEntry, "--host", "127.0.0.1", "--port", "0"];
  if (model) argv.push("--model", model);
  const proc = spawn(args.python, argv, {
    cwd: __dirname,
    env: childEnv(),
    stdio: ["ignore", "pipe", logFd],
    shell: false,
    detached: true,
  });
  closeSync(logFd);
  if (proc.pid !== undefined) {
    runtime.recordWorker(proc.pid);
    proc.once("exit", () => {
      killGroup(proc.pid, "SIGKILL"); // whatever the worker left running, an encoder child included
      runtime.forgetWorker(proc.pid);
    });
  }
  Object.assign(worker, { state: "starting", proc, pid: proc.pid ?? null, port: null, servedModels: [], lastError: null });
  const exited = new Promise((resolve) => {
    proc.once("error", () => resolve("the worker could not be spawned"));
    proc.once("exit", (code, signal) => resolve(`the worker exited (${signal ?? `code ${code}`})`));
  });
  exited.then((reason) => {
    if (worker.proc !== proc) return;
    Object.assign(worker, { state: "stopped", proc: null, pid: null, port: null, lastError: worker.state === "stopped" ? worker.lastError : reason });
  });

  const fail = async (reason) => {
    worker.lastError = reason;
    await stopWorker();
    Object.assign(worker, { state: "failed", proc: null, pid: null, port: null, lastError: reason });
    throw new Error(reason);
  };

  if (proc.pid === undefined) await fail(await exited);
  try {
    os.setPriority(proc.pid, 10);
  } catch {
    await fail("the worker priority could not be lowered");
  }

  // Stdout lines are the worker's log, until the one that says it is ready.
  const deadline = Date.now() + timeoutMs;
  let readyTimer;
  const ready = await Promise.race([
    new Promise((resolve) => {
      const lines = readline.createInterface({ input: proc.stdout });
      const sink = openSync(path.join(args.stateRoot, "logs", "worker.log"), "a");
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event?.event === "kimodo-worker-ready" && Number.isInteger(event.port)) return resolve(event);
        } catch {
          // not JSON: an ordinary log line
        }
        if (mayWrite()) writeSync(sink, `${line}\n`);
      });
      lines.on("close", () => closeSync(sink));
    }),
    exited.then((reason) => ({ failed: reason })),
    new Promise((resolve) => { readyTimer = setTimeout(() => resolve({ failed: "the worker was not ready in time" }), timeoutMs); }),
  ]);
  clearTimeout(readyTimer);
  if (ready.failed) await fail(ready.failed);
  worker.port = ready.port;

  for (;;) {
    try {
      const health = await fetch(`http://127.0.0.1:${worker.port}/health`, { signal: AbortSignal.timeout(10000) });
      const body = await health.json();
      if (health.ok && body?.ok) {
        worker.servedModels = [body.model, body.displayModel].filter(Boolean);
        worker.state = "ready";
        return;
      }
    } catch {
      // not answering yet
    }
    if (worker.proc !== proc) throw new Error(worker.lastError || "the worker exited");
    if (Date.now() > deadline) await fail("the worker did not become healthy in time");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function ensureWorker({ model = null, timeoutMs = 1000 * 60 * 8 } = {}) {
  if (starting) await starting;
  if (worker.state === "ready" && model && !worker.servedModels.includes(model)) await stopWorker();
  if (worker.state === "ready") return;
  if (!starting) starting = startWorker(model, timeoutMs).finally(() => { starting = null; });
  await starting;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function underLease(response, run) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof LeaseLost)) throw error;
    json(response, 503, { ok: false, code: stopping ? "stopping" : runtime.refusal() });
  }
}

// A seed is an integer Kimodo can take: the worker seeds with int(seed), so the daemon records exactly what it sends.
const SEED_LIMIT = 2 ** 31;

// The one source of job ids, for a generate job and a rest job alike: the clock for order, random bits for
// uniqueness, and an exclusive mkdir that decides, so two jobs never share a directory, a record or a file.
async function newJobDir(prefix) {
  guard();
  await mkdir(path.join(args.stateRoot, "artifacts"), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const jobId = `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const artifactDir = path.join(args.stateRoot, "artifacts", jobId);
    guard();
    try {
      await mkdir(artifactDir);
      return { jobId, artifactDir };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("no free job id");
}

async function generate(request, response) {
  guard();
  if (workerUnconfigured()) {
    json(response, 503, { ok: false, code: "worker-unconfigured" });
    return;
  }
  let body;
  try {
    body = await readRequestBody(request);
  } catch {
    json(response, 400, { ok: false, error: "Invalid JSON." });
    return;
  }

  const prompt = String(body.prompt || body.utterance || "").trim();
  const hasPromptInput = Boolean(prompt)
    || Array.isArray(body.texts)
    || typeof body.meta === "object"
    || body.inputFolder
    || body.input_folder;
  if (!hasPromptInput) {
    json(response, 400, { ok: false, error: "Missing prompt, utterance, texts, meta, or inputFolder." });
    return;
  }
  if (Array.isArray(body.texts) && !Array.isArray(body.durations)) {
    json(response, 400, { ok: false, error: "Batch text requests require a durations array." });
    return;
  }

  // One export plan: fbx implies the BVH and its standard T-pose, which the FBX is made from.
  const fbx = boolValue(body.fbx);
  const askedTpose = firstDefined(body.bvhStandardTpose, body.bvh_standard_tpose);
  if (fbx && ((askedTpose !== undefined && !boolValue(askedTpose))
    || (body.clipName !== undefined && !(typeof body.clipName === "string" && CLIP_NAME.test(body.clipName))))) {
    json(response, 400, { ok: false, error: "Invalid fbx request." });
    return;
  }
  if (fbx && !blenderReady()) {
    json(response, 503, { ok: false, code: "blender-unavailable" });
    return;
  }
  const plan = {
    bvh: fbx || boolValue(body.bvh),
    bvhStandardTpose: fbx || boolValue(askedTpose),
  };

  const bodyMeta = typeof body.meta === "object" && body.meta ? body.meta : {};
  const askedSeed = firstDefined(body.seed, bodyMeta.seed);
  if (askedSeed !== undefined && !(Number.isInteger(askedSeed) && askedSeed >= 0 && askedSeed < SEED_LIMIT)) {
    json(response, 400, { ok: false, error: "Invalid seed." });
    return;
  }

  const { jobId, artifactDir } = await newJobDir("vili");
  const clipName = fbx ? (body.clipName ?? jobId) : undefined;
  const duration = firstDefined(body.durationSeconds, body.duration, 4);
  const diffusionSteps = Math.max(1, Number(firstDefined(
    body.diffusionSteps,
    body.diffusion_steps,
    bodyMeta.diffusion_steps,
    20,
  )));
  const seed = askedSeed ?? randomInt(0, SEED_LIMIT);
  const numSamples = Math.max(1, Number(firstDefined(
    body.numSamples,
    body.num_samples,
    bodyMeta.num_samples,
    1,
  )));
  const meta = Object.keys(bodyMeta).length > 0
    ? { ...bodyMeta }
    : Array.isArray(body.texts)
      ? { texts: body.texts, durations: body.durations }
      : {
        text: prompt,
        duration,
      };
  meta.num_samples = Math.max(1, Number(firstDefined(body.numSamples, body.num_samples, meta.num_samples, 1)));
  meta.diffusion_steps = diffusionSteps;
  meta.seed = seed;
  if (body.cfg) meta.cfg = body.cfg;
  const constraintsPath = (() => {
    if (typeof body.constraints === "string") return body.constraints;
    if (body.constraints_path) return body.constraints_path;
    if (body.constraintsPath) return body.constraintsPath;
    if (body.constraints !== undefined) return path.join(artifactDir, "constraints.json");
    return undefined;
  })();
  if (body.constraints !== undefined && typeof body.constraints !== "string") {
    guard();
    await writeFile(path.join(artifactDir, "constraints.json"), JSON.stringify(body.constraints, null, 2));
  }
  const requestRecord = {
    schema: "gamecult.vili.motion_request.v0",
    prompt: prompt || undefined,
    texts: Array.isArray(body.texts) ? body.texts : undefined,
    meta,
    model: body.model,
    duration,
    numSamples,
    diffusion_steps: diffusionSteps,
    numTransitionFrames: firstDefined(body.numTransitionFrames, body.num_transition_frames),
    constraints: constraintsPath,
    seed,
    fbx: fbx || undefined,
    clipName,
    cfg: body.cfg,
    cfgType: firstDefined(body.cfgType, body.cfg_type),
    cfgWeight: firstDefined(body.cfgWeight, body.cfg_weight),
    ...plan,
    noPostprocess: boolValue(firstDefined(body.noPostprocess, body.no_postprocess)),
    saveExampleDir: boolValue(firstDefined(body.saveExampleDir, body.save_example_dir)),
    inputFolder: firstDefined(body.inputFolder, body.input_folder),
  };
  guard();
  await writeFile(path.join(artifactDir, "meta.json"), JSON.stringify(meta, null, 2));

  let result;
  try {
    await ensureWorker({
      timeoutMs: Number(firstDefined(body.workerTimeoutMs, body.worker_timeout_ms, 1000 * 60 * 8)),
      model: body.model || null,
    });
    const workerRequest = {
      model: body.model,
      prompt: prompt || undefined,
      texts: Array.isArray(body.texts) ? body.texts : undefined,
      meta,
      inputFolder: firstDefined(body.inputFolder, body.input_folder),
      duration,
      diffusionSteps,
      numSamples,
      numTransitionFrames: firstDefined(body.numTransitionFrames, body.num_transition_frames),
      constraints: constraintsPath,
      seed,
      cfg: body.cfg,
      cfgType: firstDefined(body.cfgType, body.cfg_type),
      cfgWeight: firstDefined(body.cfgWeight, body.cfg_weight),
      ...plan,
      noPostprocess: boolValue(firstDefined(body.noPostprocess, body.no_postprocess)),
      saveExampleDir: boolValue(firstDefined(body.saveExampleDir, body.save_example_dir)),
      output: path.join(artifactDir, "motion"),
    };
    guard();
    await writeFile(path.join(artifactDir, "request.json"), JSON.stringify(workerRequest, null, 2));
    const answer = await fetch(`http://127.0.0.1:${worker.port}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workerRequest),
      signal: AbortSignal.timeout(Number(body.timeoutMs || 1000 * 60 * 30)),
    });
    const workerBody = await answer.json();
    result = { ok: answer.ok && workerBody?.ok !== false, error: answer.ok ? null : `the worker answered ${answer.status}`, body: workerBody };
  } catch (error) {
    if (error instanceof LeaseLost) throw error;
    result = { ok: false, error: `the worker request failed (${error?.name || "Error"})`, body: null };
  }

  let exported = null;
  if (fbx && result.ok) {
    const timeoutMs = Math.min(EXPORT_TIMEOUT_MS, Math.max(1, Number(firstDefined(body.exportTimeoutMs, EXPORT_TIMEOUT_MS)) || EXPORT_TIMEOUT_MS));
    exported = await exportListed(result.body?.files, artifactDir, clipName, timeoutMs);
    if (exported.error) result = { ok: false, error: exported.error, body: result.body };
  }

  guard(); // the writer may have been lost while the job ran
  const job = await writeJobRecord({
    jobId,
    createdAt: new Date().toISOString(),
    prompt: prompt || null,
    model: body.model || result.body?.model || null,
    request: requestRecord,
    durationSeconds: duration,
    diffusionSteps,
    seed,
    artifactDir,
    ok: result.ok,
    error: result.error,
    worker: result.body,
  }, exported);
  json(response, result.ok ? 200 : 502, job);
}

// The release's own rest pose, exported as the avatar cut's source: a job like any other, made from Kimodo's
// standard-T-pose BVH that the worker interpreter's site-packages carries.
async function restFbx(response) {
  guard();
  if (!blenderReady()) {
    json(response, 503, { ok: false, code: "blender-unavailable" });
    return;
  }
  if (!restBvh || !isRegularFile(restBvh)) {
    json(response, 503, { ok: false, code: "rest-skeleton-missing" });
    return;
  }
  const { jobId, artifactDir } = await newJobDir("rest");
  guard();
  await copyFile(restBvh, path.join(artifactDir, "SOMA77_Rest.bvh"));
  const exported = await exportListed([path.join(artifactDir, "SOMA77_Rest.bvh")], artifactDir, "SOMA77_Rest", EXPORT_TIMEOUT_MS);
  guard();
  const job = await writeJobRecord({
    jobId,
    createdAt: new Date().toISOString(),
    prompt: null,
    model: null,
    request: null,
    durationSeconds: null,
    diffusionSteps: null,
    seed: null,
    artifactDir,
    ok: !exported.error,
    error: exported.error,
    worker: null,
  }, exported);
  json(response, job.ok ? 200 : 502, job);
}

// Reads only: a job's own FBX and BVH files, by exact name, regular files inside the job's artifact directory.
const ARTIFACT_ROUTE = /^\/motion\/artifacts\/((?:vili|rest)-[0-9]{13}-[0-9a-f]{8})\/(motion\.fbx|motion\.bvh|SOMA77_Rest\.fbx|motion\/motion_[0-9]{2}\.(?:fbx|bvh))$/;

async function serveArtifact(response, jobId, name) {
  const directory = path.join(args.stateRoot, "artifacts", jobId);
  const file = path.join(directory, name);
  let bytes = null;
  if (regularFileInside(file, directory)) {
    try {
      bytes = await readFile(file);
    } catch {
      // gone between the check and the read
    }
  }
  if (bytes === null) {
    text(response, 404, "not found\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
  response.end(bytes);
}

const SNAPSHOT_BODY_MAX = 64 * 1024;

// Idunn's route challenge: a msgpack POST from the host, answered from local authority. A browser page can send
// it too, so an Origin is refused exactly as on every other POST. Only the Idunn runtime answers; the hand-run
// daemon has no such route.
async function answerRouteChallenge(request, response) {
  if (!runtime.answerSnapshot) {
    text(response, 404, "not found\n");
    return;
  }
  if (request.headers.origin !== undefined) {
    json(response, 403, { ok: false, code: "cross-site" });
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > SNAPSHOT_BODY_MAX) {
      json(response, 400, { ok: false, code: "invalid-snapshot-request" });
      return;
    }
    chunks.push(chunk);
  }
  let answer;
  try {
    answer = runtime.answerSnapshot(Buffer.concat(chunks));
  } catch (error) {
    if (error?.code === "invalid-snapshot-request") json(response, 400, { ok: false, code: error.code });
    else json(response, 503, { ok: false, code: "runtime-presence-unavailable" });
    return;
  }
  response.writeHead(200, { "content-type": "application/msgpack", "cache-control": "no-store" });
  response.end(answer);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${args.host}:${args.port}`}`);
  if (url.pathname === "/cultnet/snapshot" && request.method === "POST") {
    await answerRouteChallenge(request, response);
    return;
  }
  const artifact = request.method === "GET" ? ARTIFACT_ROUTE.exec(url.pathname) : null;
  if (artifact) {
    await serveArtifact(response, artifact[1], artifact[2]);
    return;
  }
  if (request.method === "POST" && refuseCrossSite(request, response)) return;

  if (url.pathname === "/" || url.pathname === "/health") {
    json(response, 200, { ok: true, service: "vili", providerId, state: operatorState() });
  } else if (url.pathname === "/operator-state") {
    json(response, 200, operatorState());
  } else if (url.pathname === "/motion/generate" && request.method === "POST") {
    await underLease(response, () => generate(request, response));
  } else if (url.pathname === "/motion/rest-fbx" && request.method === "POST") {
    await underLease(response, () => restFbx(response));
  } else {
    text(response, 404, "not found\n");
  }
}

let runtime;
let stopping = false;

class LeaseLost extends Error {}

// The one write authority: the runtime holds the state root (the lease, or the lock) and the daemon is not stopping.
// held() is read at the moment of every ask, so a loss is seen by the first gate to ask.
function mayWrite() {
  return !stopping && runtime.held();
}

// The one write gate. Every write to the state root and every spawn calls it, immediately before it happens (not once
// per request), so a request admitted before the lease went, or before SIGTERM, still stops at its next write.
function guard() {
  if (!mayWrite()) throw new LeaseLost("the writer was lost");
}

// How often the lease is asked while nothing else asks, and so how long a worker can outlive a loss (plus the
// SIGKILL): a generate can await its worker for 30 minutes. The service documents are rewritten every PERSIST_EVERY asks.
const WATCH_MS = 250;
const PERSIST_EVERY = 20;

// The one daemon. `rt` owns the state root: the hand-run runtime (socket lock) or Idunn's (process write lease).
// The server listens first, so Idunn's challenge can be answered while the lease is still pending; nothing is
// written to the state root until the runtime holds it.
export async function serve(rt) {
  runtime = rt;
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      // The error's message can carry the request; name only its class.
      console.error(`request failed: ${error?.name || "Error"}`);
      if (!response.headersSent) json(response, 500, { ok: false, code: "internal" });
      else response.end();
    });
  });
  await new Promise((resolve) => server.listen(args.port, args.host, resolve));
  console.log(`Vili listening on http://${args.host}:${server.address().port}`);

  let tick = null;
  // From the signal on nothing is accepted, written or spawned (guard() refuses what is already in flight); then the
  // worker tree is stopped, and only then does the process end.
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    clearInterval(tick);
    await Promise.all([stopWorker(), stopExports()]);
    runtime.release();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await runtime.acquire();
  let lost = false;
  const onLost = () => {
    if (lost) return;
    lost = true;
    clearInterval(tick);
    Promise.all([stopWorker(["SIGKILL"]), stopExports(["SIGKILL"])]).finally(() => runtime.reportHealth?.("degraded"));
  };
  runtime.watch(onLost); // held() reports a loss through this the moment any gate sees it
  try {
    guard();
    await mkdir(path.join(args.stateRoot, "jobs"), { recursive: true });
    await mkdir(path.join(args.stateRoot, WORK_DIR), { recursive: true });
    await sweepWork();
    await persistSurfaces();
    await probeBlender();
  } catch (error) {
    if (error instanceof LeaseLost) return; // lost while opening the state root: onLost has run, and nothing is active
    throw error;
  }
  let asks = 0;
  tick = setInterval(() => {
    runtime.watch(onLost);
    if (lost || ++asks % PERSIST_EVERY !== 0) return;
    persistSurfaces().catch((error) => {
      if (!(error instanceof LeaseLost)) console.error(`persist failed: ${error?.name || "Error"}`);
    });
  }, WATCH_MS);
  if (lost) return;
  runtime.reportHealth?.("active");
  console.log("Vili holds the state root");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve(handRunRuntime(args.stateRoot));
}
