#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import { closeSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentRegistry,
  defineDocumentType,
} = require("cultcache-ts");
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
    health: false,
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
    else if (arg === "--health") args.health = true;
  }
  if (!/^[0-9]{1,2}$/.test(String(args.threads)) || Number(args.threads) < 1 || Number(args.threads) > MAX_THREADS) {
    console.error(`threads must be an integer from 1 to ${MAX_THREADS}`);
    process.exit(2);
  }
  args.threads = Number(args.threads);
  if (args.modelsRoot) args.modelsRoot = path.resolve(args.modelsRoot);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();

// The worker child. Display state only: nothing reads `worker` to decide anything but ensureWorker.
const worker = { state: "stopped", proc: null, pid: null, port: null, servedModels: [], lastError: null };
let starting = null;

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
        ],
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
  await mkdir(args.stateRoot, { recursive: true });
  const cache = CultCache.builder()
    .withRegistry(viliDocumentRegistry)
    .withGenericStore(new SingleFileMessagePackBackingStore(path.join(args.stateRoot, viliStoreFileName)))
    .build();
  await cache.put(operatorStateDefinition, "vili", operatorState());
  await cache.put(commandBoundaryDefinition, "vili", commandBoundary());
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
// too. The daemon owns the whole group: it is killed when the worker exits for any reason, on a requested stop, and
// at the next start if a crashed daemon left it behind (reclaimStrayWorker). Under systemd, KillMode=control-group
// is the same ownership from outside the process.
const workerPidFile = () => path.join(args.stateRoot, "worker.pid");

function killGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false; // no such group
  }
}

function forgetWorkerPid(pid) {
  try {
    if (readFileSync(workerPidFile(), "utf8").trim() === String(pid)) unlinkSync(workerPidFile());
  } catch {
    // no pid file, or another worker's
  }
}

// A worker left by a crashed daemon: the pid file names its group, and the group is ours only if some member
// still carries this state root's embeddings directory in its environment (the pid may have been reused).
function reclaimStrayWorker() {
  let pgid;
  try {
    pgid = Number(readFileSync(workerPidFile(), "utf8").trim());
  } catch {
    return;
  }
  const marker = `VILI_EMBEDDINGS_DIR=${path.join(args.stateRoot, "embeddings")}`;
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
    unlinkSync(workerPidFile());
  } catch {
    // already gone
  }
}

async function stopWorker() {
  const proc = worker.proc;
  if (!proc || proc.pid === undefined) return;
  worker.state = "stopped";
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    killGroup(proc.pid, signal);
    if (await waitForExit(proc, signal === "SIGTERM" ? 10000 : 5000)) break;
  }
}

async function startWorker(model, timeoutMs) {
  await mkdir(path.join(args.stateRoot, "logs"), { recursive: true });
  await mkdir(path.join(args.stateRoot, "embeddings"), { recursive: true });
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
    writeFileSync(workerPidFile(), `${proc.pid}\n`);
    proc.once("exit", () => {
      killGroup(proc.pid, "SIGKILL"); // whatever the worker left running, an encoder child included
      forgetWorkerPid(proc.pid);
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
        writeSync(sink, `${line}\n`);
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

async function generateMotion(request, response) {
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

  const jobId = `vili-${Date.now()}`;
  const artifactDir = path.join(args.stateRoot, "artifacts", jobId);
  await mkdir(artifactDir, { recursive: true });
  const duration = firstDefined(body.durationSeconds, body.duration, 4);
  const bodyMeta = typeof body.meta === "object" && body.meta ? body.meta : {};
  const diffusionSteps = Math.max(1, Number(firstDefined(
    body.diffusionSteps,
    body.diffusion_steps,
    bodyMeta.diffusion_steps,
    20,
  )));
  const seed = body.seed === undefined ? null : Number(body.seed);
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
  if (Number.isFinite(seed)) meta.seed = seed;
  if (body.cfg) meta.cfg = body.cfg;
  const constraintsPath = (() => {
    if (typeof body.constraints === "string") return body.constraints;
    if (body.constraints_path) return body.constraints_path;
    if (body.constraintsPath) return body.constraintsPath;
    if (body.constraints !== undefined) return path.join(artifactDir, "constraints.json");
    return undefined;
  })();
  if (body.constraints !== undefined && typeof body.constraints !== "string") {
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
    seed: Number.isFinite(seed) ? seed : undefined,
    cfg: body.cfg,
    cfgType: firstDefined(body.cfgType, body.cfg_type),
    cfgWeight: firstDefined(body.cfgWeight, body.cfg_weight),
    bvh: boolValue(body.bvh),
    bvhStandardTpose: boolValue(firstDefined(body.bvhStandardTpose, body.bvh_standard_tpose)),
    noPostprocess: boolValue(firstDefined(body.noPostprocess, body.no_postprocess)),
    saveExampleDir: boolValue(firstDefined(body.saveExampleDir, body.save_example_dir)),
    inputFolder: firstDefined(body.inputFolder, body.input_folder),
  };
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
      seed: Number.isFinite(seed) ? seed : undefined,
      cfg: body.cfg,
      cfgType: firstDefined(body.cfgType, body.cfg_type),
      cfgWeight: firstDefined(body.cfgWeight, body.cfg_weight),
      bvh: boolValue(body.bvh),
      bvhStandardTpose: boolValue(firstDefined(body.bvhStandardTpose, body.bvh_standard_tpose)),
      noPostprocess: boolValue(firstDefined(body.noPostprocess, body.no_postprocess)),
      saveExampleDir: boolValue(firstDefined(body.saveExampleDir, body.save_example_dir)),
      output: path.join(artifactDir, "motion"),
    };
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
    result = { ok: false, error: `the worker request failed (${error?.name || "Error"})`, body: null };
  }

  const job = {
    schema: "gamecult.vili.motion_job.v0",
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
  };
  await writeFile(path.join(args.stateRoot, "jobs", `${jobId}.json`), JSON.stringify(job, null, 2));
  json(response, result.ok ? 200 : 502, job);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${args.host}:${args.port}`}`);
  if (request.method === "POST" && refuseCrossSite(request, response)) return;

  if (url.pathname === "/" || url.pathname === "/health") {
    json(response, 200, { ok: true, service: "vili", providerId, state: operatorState() });
  } else if (url.pathname === "/operator-state") {
    json(response, 200, operatorState());
  } else if (url.pathname === "/motion/generate" && request.method === "POST") {
    await generateMotion(request, response);
  } else {
    text(response, 404, "not found\n");
  }
}

async function healthCheck() {
  const host = args.host === "0.0.0.0" ? "127.0.0.1" : args.host;
  const response = await fetch(`http://${host}:${args.port}/health`);
  if (!response.ok) throw new Error(`health returned ${response.status}`);
  const body = await response.json();
  if (!body.ok) throw new Error("health returned ok=false");
}

if (args.health) {
  healthCheck().then(() => process.exit(0), (error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  await mkdir(path.join(args.stateRoot, "jobs"), { recursive: true });
  await persistSurfaces();

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      // The error's message can carry the request; name only its class.
      console.error(`request failed: ${error?.name || "Error"}`);
      if (!response.headersSent) json(response, 500, { ok: false, code: "internal" });
      else response.end();
    });
  });

  server.listen(args.port, args.host, () => {
    reclaimStrayWorker(); // synchronous: no request is served before a predecessor's worker is gone
    console.log(`Vili listening on http://${args.host}:${server.address().port}`);
  });

  const surfaceTimer = setInterval(() => persistSurfaces().catch((error) => console.error(`persist failed: ${error?.name || "Error"}`)), 5000);

  const shutdown = async () => {
    clearInterval(surfaceTimer);
    await stopWorker();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
