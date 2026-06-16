#!/usr/bin/env node
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  CULTNET_RUDP_PROTOCOL_ID,
  createIdunnRudpHealthPublisher,
  publishIdunnRudpHealth,
} = require("./idunn-rudp.cjs");
const projectRoot = path.resolve(__dirname, "..");
const ravenBaseUrl = process.env.VILI_PUBLIC_BASE_URL || "http://10.77.0.4:8824";
const ravenDeckUrl = process.env.VILI_PUBLIC_DECK_URL || "ws://10.77.0.4:8824/eve/deck";
const providerId = "vili.animation";
const idunnHealthContract = "vili.cultnet-rudp-animation-health";
const kimodoWorkerName = process.env.VILI_KIMODO_WORKER_NAME || "vili-kimodo-worker";
const kimodoWorkerPort = Number(process.env.VILI_KIMODO_WORKER_PORT || 8825);
const kimodoWorkerUrl = `http://127.0.0.1:${kimodoWorkerPort}`;
const dockerHuggingFaceEnv = [
  "export HF_TOKEN=\"$(cat /root/.cache/huggingface/token 2>/dev/null || true)\"",
  "export HUGGING_FACE_HUB_TOKEN=\"$HF_TOKEN\"",
].join("; ");
const dockerHuggingFaceArgs = [
  "-e HF_TOKEN",
  "-e HUGGING_FACE_HUB_TOKEN",
  "-v /root/.cache/huggingface:/root/.cache/huggingface",
].join(" ");

function parseArgs(argv) {
  const args = {
    host: process.env.VILI_DAEMON_HOST || "127.0.0.1",
    port: Number(process.env.VILI_DAEMON_PORT || 8824),
    stateRoot: process.env.VILI_STATE_ROOT || path.join(projectRoot, ".vili"),
    idunnRudpHealth: process.env.VILI_IDUNN_RUDP_HEALTH || null,
    idunnDaemon: process.env.VILI_IDUNN_DAEMON || "vili",
    idunnHealthContract: process.env.VILI_IDUNN_HEALTH_CONTRACT || idunnHealthContract,
    idunnHealthIntervalSeconds: Number(process.env.VILI_IDUNN_HEALTH_INTERVAL_SECONDS || 15),
    health: false,
    printProviderAdvertisement: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--state-root") args.stateRoot = path.resolve(argv[++index]);
    else if (arg === "--idunn-rudp-health") args.idunnRudpHealth = argv[++index];
    else if (arg === "--idunn-daemon") args.idunnDaemon = argv[++index];
    else if (arg === "--idunn-health-contract") args.idunnHealthContract = argv[++index];
    else if (arg === "--idunn-health-interval-seconds") args.idunnHealthIntervalSeconds = Number(argv[++index]);
    else if (arg === "--health") args.health = true;
    else if (arg === "--print-provider-advertisement") args.printProviderAdvertisement = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const idunnRudpHealthPublisher = createIdunnRudpHealthPublisher(args.idunnRudpHealth ? {
  endpoint: args.idunnRudpHealth,
  daemonId: args.idunnDaemon,
  healthContract: args.idunnHealthContract,
  sourceRuntimeId: "vili-daemon",
} : null);
let backendStatus = {
  checkedAt: null,
  dockerImage: "unknown",
  nvidiaRuntime: "unknown",
  huggingFaceToken: "unknown",
  kimodoHelp: "unknown",
  kimodoWorker: "unknown",
  kimodoWorkerDetail: null,
  lastError: null,
};
let idunnRudpHealthStatus = {
  endpoint: args.idunnRudpHealth,
  daemon: args.idunnDaemon,
  contract: args.idunnHealthContract,
  transport: CULTNET_RUDP_PROTOCOL_ID,
  status: idunnRudpHealthPublisher ? "pending" : "disabled",
  lastPublishedAt: null,
  lastErrorAt: null,
  error: "",
  inFlight: false,
};

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    execFile(command, commandArgs, {
      cwd: projectRoot,
      timeout: options.timeout ?? 20000,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        error: error ? String(error.message || error) : null,
      });
    });
  });
}

function wsl(script, options = {}) {
  return run("wsl.exe", ["-d", "Ubuntu-24.04", "-u", "root", "--", "bash", "-lc", script], options);
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function boolValue(value) {
  return value === true || String(value).toLowerCase() === "true" || String(value) === "1";
}

async function wslJson(script, options = {}) {
  const result = await wsl(script, options);
  if (!result.ok) return { ...result, body: null };
  try {
    return { ...result, body: JSON.parse(result.stdout) };
  } catch (error) {
    return { ...result, ok: false, body: null, error: `Invalid JSON: ${error.message}`, stderr: result.stderr };
  }
}

function json(response, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(payload);
}

function text(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  response.end(body);
}

function providerAdvertisement() {
  return {
    schema: "gamecult.eve.provider_advertisement.v1",
    providerId,
    title: "Vili Animation",
    description: "Persona animation and Kimodo motion generation daemon on Raven.",
    canonicalService: "asgard.vili",
    locatedService: "asgard.raven.vili",
    verseId: "raven.local",
    cultMeshAddress: "asgard.raven.vili/eve/operator",
    updatedAt: new Date().toISOString(),
    endpoints: {
      http: ravenBaseUrl,
      health: `${ravenBaseUrl}/health`,
      smoke: `${ravenBaseUrl}/smoke`,
      providerAdvertisement: `${ravenBaseUrl}/provider-advertisement`,
      operatorState: `${ravenBaseUrl}/operator-state`,
      operatorSurface: `${ravenBaseUrl}/eve/operator`,
      deckBroker: ravenDeckUrl,
      providerDeck: `${ravenDeckUrl}/${providerId}`,
    },
    capabilities: [
      "kimodo.motion.generate",
      "persona.performance.intent",
      "eve.operator.surface",
      "cultmesh.provider.discovery",
    ],
  };
}

function operatorState() {
  return {
    schema: "gamecult.vili.operator_state.v0",
    service: "vili",
    providerId,
    verseId: "raven.local",
    host: "raven",
    startedAt,
    updatedAt: new Date().toISOString(),
    backend: backendStatus,
    idunnRudpHealth: idunnRudpHealthStatus,
    authority: {
      owns: [
        "animation job intake",
        "Kimodo runtime checks",
        "Kimodo resident worker lifecycle",
        "motion artifact references",
        "Vili provider and operator surfaces",
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
      providerAdvertisement: "/provider-advertisement",
      operatorState: "/operator-state",
      operatorSurface: "/eve/operator",
      deckProviders: "/eve/deck/providers",
      smoke: "/smoke",
      generate: "/motion/generate",
    },
  };
}

function viliHealthDetail() {
  const worker = backendStatus.kimodoWorker || "unknown";
  return `Vili animation daemon active on Raven; Kimodo worker ${worker}; HTTP/WS are compatibility lowerings.`;
}

async function publishIdunnHealthOnce() {
  if (!idunnRudpHealthPublisher || idunnRudpHealthStatus.inFlight) return;
  const observedAt = new Date().toISOString();
  idunnRudpHealthStatus = {
    ...idunnRudpHealthStatus,
    status: "publishing",
    inFlight: true,
    error: "",
  };
  try {
    await publishIdunnRudpHealth(idunnRudpHealthPublisher, {
      state: "active",
      detail: viliHealthDetail(),
      observedAt,
    });
    idunnRudpHealthStatus = {
      ...idunnRudpHealthStatus,
      status: "published",
      lastPublishedAt: observedAt,
      inFlight: false,
      error: "",
    };
  } catch (error) {
    idunnRudpHealthStatus = {
      ...idunnRudpHealthStatus,
      status: "failed",
      lastErrorAt: new Date().toISOString(),
      inFlight: false,
      error: error.message,
    };
  }
  await persistSurfaces();
}

function startIdunnHealthPublisher() {
  if (!idunnRudpHealthPublisher) return;
  publishIdunnHealthOnce().catch((error) => console.error(error));
  const intervalMs = Math.max(5, args.idunnHealthIntervalSeconds) * 1000;
  setInterval(() => publishIdunnHealthOnce().catch((error) => console.error(error)), intervalMs);
}

function eveSurface() {
  const state = operatorState();
  return {
    schema: "gamecult.eve.surface.v1",
    providerId,
    title: "Vili Animation",
    updatedAt: state.updatedAt,
    surface: {
      root: {
        type: "panel",
        title: "Vili Animation",
        children: [
          { type: "stat", label: "Host", value: "Raven" },
          { type: "stat", label: "Verse", value: "raven.local" },
          { type: "stat", label: "Docker image", value: state.backend.dockerImage },
          { type: "stat", label: "NVIDIA runtime", value: state.backend.nvidiaRuntime },
          { type: "stat", label: "Kimodo", value: state.backend.kimodoHelp },
          { type: "stat", label: "Kimodo worker", value: state.backend.kimodoWorker },
          { type: "stat", label: "HF token", value: state.backend.huggingFaceToken },
          { type: "command", label: "Smoke", method: "GET", href: `${ravenBaseUrl}/smoke` },
          { type: "command", label: "Generate motion", method: "POST", href: `${ravenBaseUrl}/motion/generate` },
        ],
      },
    },
    state,
  };
}

async function persistSurfaces() {
  await mkdir(args.stateRoot, { recursive: true });
  await writeFile(path.join(args.stateRoot, "vili-daemon.pid"), `${process.pid}\n`);
  await writeFile(path.join(args.stateRoot, "provider-advertisement.json"), JSON.stringify(providerAdvertisement(), null, 2));
  await writeFile(path.join(args.stateRoot, "operator-state.json"), JSON.stringify(operatorState(), null, 2));
  await writeFile(path.join(args.stateRoot, "eve-operator-surface.json"), JSON.stringify(eveSurface(), null, 2));
}

async function refreshBackendStatus({ includeKimodoHelp = false } = {}) {
  const docker = await wsl([
    "set -e",
    "service docker start >/dev/null 2>&1 || true",
    "docker images gamecult/kimodo:latest --format '{{.Repository}}:{{.Tag}}' | head -n 1",
  ].join("; "), { timeout: 20000 });

  let nvidia = await wsl([
    "set -e",
    "service docker start >/dev/null 2>&1 || true",
    "docker info --format '{{json .Runtimes}}' | grep -q nvidia && echo configured || echo missing",
  ].join("; "), { timeout: 20000 });

  const token = await wsl("test -f /root/.cache/huggingface/token && echo present || echo missing", { timeout: 10000 });
  const worker = await kimodoWorkerHealth(20000);
  let help = { ok: true, stdout: backendStatus.kimodoHelp === "ok" ? "ok" : "not checked", stderr: "" };
  if (includeKimodoHelp) {
    nvidia = await wsl([
      "set -e",
      "service docker start >/dev/null 2>&1 || true",
      "docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1",
    ].join("; "), { timeout: 45000 });
    help = await wsl([
      "set -e",
      "service docker start >/dev/null 2>&1 || true",
      dockerHuggingFaceEnv,
      `docker run --rm --runtime=nvidia --gpus all ${dockerHuggingFaceArgs} gamecult/kimodo:latest kimodo_gen --help | sed -n '1,6p'`,
    ].join("; "), { timeout: 60000 });
  }

  backendStatus = {
    checkedAt: new Date().toISOString(),
    dockerImage: docker.ok && docker.stdout ? docker.stdout : "missing",
    nvidiaRuntime: nvidia.ok && nvidia.stdout ? nvidia.stdout : "unavailable",
    huggingFaceToken: token.ok ? token.stdout : "unknown",
    kimodoHelp: includeKimodoHelp ? (help.ok ? "ok" : "failed") : backendStatus.kimodoHelp,
    kimodoWorker: worker.ok && worker.body?.ok ? "resident" : "not running",
    kimodoWorkerDetail: worker.body || null,
    lastError: [docker, nvidia, token, help].find((result) => !result.ok)?.stderr || null,
  };
  await persistSurfaces();
  return { docker, nvidia, token, help, backendStatus };
}

async function kimodoWorkerHealth(timeout = 10000) {
  return wslJson(`curl -fsS --max-time ${Math.ceil(timeout / 1000)} ${shQuote(`${kimodoWorkerUrl}/health`)}`, { timeout });
}

async function startKimodoWorker({ model = null } = {}) {
  const script = [
    "set -e",
    "service docker start >/dev/null 2>&1 || true",
    dockerHuggingFaceEnv,
    "mkdir -p /mnt/e/Projects/Vili/.vili/artifacts /mnt/e/Projects/Vili/.vili/logs",
    "if ! kill -0 $(cat /tmp/vili-wsl-keepalive.pid 2>/dev/null) >/dev/null 2>&1; then nohup bash -c 'while true; do sleep 3600; done' >/tmp/vili-wsl-keepalive.log 2>&1 & echo $! >/tmp/vili-wsl-keepalive.pid; fi",
    `if docker ps --format '{{.Names}}' | grep -qx ${shQuote(kimodoWorkerName)}; then echo running; exit 0; fi`,
    `docker rm -f ${shQuote(kimodoWorkerName)} >/dev/null 2>&1 || true`,
    [
      "docker run -d",
      `--name ${shQuote(kimodoWorkerName)}`,
      "--runtime=nvidia --gpus all",
      `-p 127.0.0.1:${kimodoWorkerPort}:${kimodoWorkerPort}`,
      dockerHuggingFaceArgs,
      "-e TEXT_ENCODER_DEVICE=cpu",
      "-v /mnt/e/Projects/Vili/scripts/kimodo-resident-worker.py:/opt/vili/kimodo-resident-worker.py:ro",
      "-v /mnt/e/Projects/Vili/.vili/artifacts:/outputs",
      "gamecult/kimodo:latest",
      "python",
      "/opt/vili/kimodo-resident-worker.py",
      `--port ${kimodoWorkerPort}`,
      model ? `--model ${shQuote(model)}` : "",
    ].join(" "),
  ].join("; ");
  return wsl(script, { timeout: 30000 });
}

async function ensureKimodoWorker({ timeoutMs = 1000 * 60 * 8, model = null } = {}) {
  const health = await kimodoWorkerHealth(10000);
  if (health.ok && health.body?.ok) {
    if (!model || health.body.model === model || health.body.displayModel === model) return health;
    await wsl(`docker rm -f ${shQuote(kimodoWorkerName)} >/dev/null 2>&1 || true`, { timeout: 30000 });
  }

  const started = await startKimodoWorker({ model });
  if (!started.ok) return started;

  const deadline = Date.now() + timeoutMs;
  let last = started;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    last = await kimodoWorkerHealth(10000);
    if (last.ok && last.body?.ok) return last;
  }
  return {
    ok: false,
    stdout: last.stdout || "",
    stderr: last.stderr || "",
    error: `Kimodo worker did not become healthy within ${timeoutMs}ms.`,
    body: last.body || null,
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function generateMotion(request, response) {
  let body;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: `Invalid JSON: ${error.message}` });
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
    if (body.constraints !== undefined) return `/outputs/${jobId}/constraints.json`;
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
  const worker = await ensureKimodoWorker({
    timeoutMs: Number(firstDefined(body.workerTimeoutMs, body.worker_timeout_ms, 1000 * 60 * 8)),
    model: body.model || null,
  });
  let result = worker;
  if (worker.ok) {
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
      output: `/outputs/${jobId}/motion`,
    };
    await writeFile(path.join(artifactDir, "request.json"), JSON.stringify(workerRequest, null, 2));
    const curlCommand = [
      `curl -sS --max-time ${Math.ceil(Number(body.timeoutMs || 1000 * 60 * 30) / 1000)}`,
      "-H 'content-type: application/json'",
      `--data-binary @${shQuote(`/mnt/e/Projects/Vili/.vili/artifacts/${jobId}/request.json`)}`,
      shQuote(`${kimodoWorkerUrl}/generate`),
    ].join(" ");
    result = await wslJson([
      "set -e",
      curlCommand,
    ].join("; "), { timeout: Number(body.timeoutMs || 1000 * 60 * 30) });
    if (result.body?.ok === false) result = { ...result, ok: false };
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
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    worker: result.body,
  };
  await writeFile(path.join(args.stateRoot, "jobs", `${jobId}.json`), JSON.stringify(job, null, 2)).catch(async () => {
    await mkdir(path.join(args.stateRoot, "jobs"), { recursive: true });
    await writeFile(path.join(args.stateRoot, "jobs", `${jobId}.json`), JSON.stringify(job, null, 2));
  });
  json(response, result.ok ? 200 : 502, job);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${args.host}:${args.port}`}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    response.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    await refreshBackendStatus({ includeKimodoHelp: false });
    json(response, 200, { ok: true, service: "vili", providerId, state: operatorState() });
  } else if (url.pathname === "/provider-advertisement") {
    json(response, 200, providerAdvertisement());
  } else if (url.pathname === "/operator-state") {
    json(response, 200, operatorState());
  } else if (url.pathname === "/eve/operator") {
    json(response, 200, eveSurface());
  } else if (url.pathname === "/eve/deck/providers") {
    json(response, 200, {
      providers: [{
        id: providerId,
        title: "Vili Animation",
        description: "Persona animation and Kimodo motion generation daemon.",
        endpoint: `${ravenDeckUrl}/${providerId}`,
      }],
    });
  } else if (url.pathname === "/smoke") {
    const result = await refreshBackendStatus({ includeKimodoHelp: true });
    const worker = await ensureKimodoWorker();
    await refreshBackendStatus({ includeKimodoHelp: false });
    const ok = result.backendStatus.kimodoHelp === "ok" && worker.ok && worker.body?.ok;
    json(response, ok ? 200 : 502, { ok, ...result, worker: worker.body || worker });
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

if (args.printProviderAdvertisement) {
  console.log(JSON.stringify(providerAdvertisement(), null, 2));
  process.exit(0);
}

if (args.health) {
  healthCheck().then(() => process.exit(0), (error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  await mkdir(path.join(args.stateRoot, "jobs"), { recursive: true });
  await persistSurfaces();
  if (!existsSync(path.join(args.stateRoot, "backend-status.json"))) {
    await writeFile(path.join(args.stateRoot, "backend-status.json"), JSON.stringify(backendStatus, null, 2));
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      json(response, 500, { ok: false, error: error.message, stack: process.env.NODE_ENV === "development" ? error.stack : undefined });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    const sendSurface = () => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(eveSurface()));
    };
    sendSurface();
    const timer = setInterval(sendSurface, 5000);
    socket.on("close", () => clearInterval(timer));
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || `${args.host}:${args.port}`}`);
    if (url.pathname === `/eve/deck/${providerId}` || url.pathname === "/eve/deck") {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } else {
      socket.destroy();
    }
  });

  server.listen(args.port, args.host, () => {
    console.log(`Vili listening on http://${args.host}:${args.port}`);
  });

  startIdunnHealthPublisher();
  setInterval(() => persistSurfaces().catch((error) => console.error(error)), 5000);
}
