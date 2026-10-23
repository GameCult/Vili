#!/usr/bin/env node
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import { RETRY_AFTER_SECONDS, admitThen, createGpuTenancy, gpuTenancyOptionsFromEnv, parseFreeMiB, placementRefusal } from "./gpu-tenancy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  CultCache,
  SingleFileMessagePackBackingStore,
  defineDocumentRegistry,
  defineDocumentType,
} = require("cultcache-ts");
const projectRoot = path.resolve(__dirname, "..");
const ravenBaseUrl = process.env.VILI_PUBLIC_BASE_URL || "http://10.77.0.4:8824";
const ravenDeckUrl = process.env.VILI_PUBLIC_DECK_URL || "ws://10.77.0.4:8824/eve/deck";
const providerId = "vili.animation";
const viliStoreFileName = "vili.service.cc";
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
const objectSchema = { parse: (value) => value };
const providerAdvertisementDefinition = defineDocumentType({
  type: "gamecult.eve.provider_advertisement",
  schemaName: "gamecult.eve.provider_advertisement",
  schemaId: "gamecult.eve.provider_advertisement.v1",
  schemaVersion: "gamecult.eve.provider_advertisement.v1",
  name: (value) => value?.providerId || "provider",
  schema: objectSchema,
  members: [
    { slot: 0, memberName: "providerId", typeName: "string", isName: true },
    { slot: 1, memberName: "title", typeName: "string" },
    { slot: 2, memberName: "verseId", typeName: "string" },
    { slot: 3, memberName: "updatedAt", typeName: "string" },
  ],
});
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
    { slot: 4, memberName: "gpu", typeName: "object" },
  ],
});
const gpuPermissionDefinition = defineDocumentType({
  type: "gamecult.vili.gpu_permission",
  schemaName: "gamecult.vili.gpu_permission",
  schemaId: "gamecult.vili.gpu_permission.v1",
  schemaVersion: "gamecult.vili.gpu_permission.v1",
  name: (value) => value?.host || "raven",
  schema: objectSchema,
  members: [
    { slot: 0, memberName: "host", typeName: "string", isName: true },
    { slot: 1, memberName: "allowed", typeName: "boolean" },
    { slot: 2, memberName: "changedAt", typeName: "string" },
  ],
});
const eveSurfaceDefinition = defineDocumentType({
  type: "gamecult.eve.surface_state",
  schemaName: "gamecult.eve.surface_state",
  schemaId: "gamecult.eve.surface_state.v1",
  schemaVersion: "gamecult.eve.surface_state.v1",
  name: (value) => value?.providerId || "surface",
  schema: objectSchema,
  members: [
    { slot: 0, memberName: "providerId", typeName: "string", isName: true },
    { slot: 1, memberName: "title", typeName: "string" },
    { slot: 2, memberName: "updatedAt", typeName: "string" },
    { slot: 3, memberName: "surface", typeName: "object" },
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
  providerAdvertisementDefinition,
  operatorStateDefinition,
  gpuPermissionDefinition,
  eveSurfaceDefinition,
  commandBoundaryDefinition,
  transportProfileDefinition,
);

function parseArgs(argv) {
  const args = {
    // Comma-separated addresses to listen on, one server each. Never 0.0.0.0: the daemon answers
    // this machine and the WireGuard address, not whatever network the machine joins next.
    host: process.env.VILI_DAEMON_HOST || "127.0.0.1",
    port: Number(process.env.VILI_DAEMON_PORT || 8824),
    stateRoot: process.env.VILI_STATE_ROOT || path.join(projectRoot, ".vili"),
    health: false,
    printProviderAdvertisement: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--state-root") args.stateRoot = path.resolve(argv[++index]);
    else if (arg === "--health") args.health = true;
    else if (arg === "--print-provider-advertisement") args.printProviderAdvertisement = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const hosts = args.host.split(",").map((host) => host.trim()).filter(Boolean);
const startedAt = new Date().toISOString();
const gpuOptions = gpuTenancyOptionsFromEnv(process.env);
// The daemon's one cache and store instance: every write to vili.service.cc goes through one queue.
const viliCache = CultCache.builder()
  .withRegistry(viliDocumentRegistry)
  .withGenericStore(new SingleFileMessagePackBackingStore(path.join(args.stateRoot, viliStoreFileName)))
  .build();
let storedPermission;
if (!args.health && !args.printProviderAdvertisement) {
  await viliCache.pullAllBackingStores();
  storedPermission = viliCache.get(gpuPermissionDefinition, "raven");
}
const gpuTenancy = createGpuTenancy({
  now: Date.now,
  ...gpuOptions,
  permission: storedPermission,
  savePermission: (value) => viliCache.put(gpuPermissionDefinition, "raven", { host: "raven", ...value }),
  readFreeMiB: hostFreeMiB,
});
let backendStatus = {
  checkedAt: null,
  dockerImage: "unknown",
  nvidiaRuntime: "unknown",
  huggingFaceToken: "unknown",
  kimodoWorker: "unknown",
  kimodoWorkerDetail: null,
  lastError: null,
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

async function hostFreeMiB() {
  const r = await run("nvidia-smi.exe", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { timeout: 5000 });
  return r.ok ? parseFreeMiB(r.stdout) : null;
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

function json(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    ...headers,
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
    gpu: gpuTenancy.status(),
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
      generate: "/motion/generate",
      gpuPermission: "/gpu-permission",
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
          "Kimodo resident worker lifecycle",
          "timeout handling",
          "motion artifact references",
        ],
      },
      gpuPermission: {
        method: "POST",
        path: "/gpu-permission",
        owns: ["the household GPU permission for this host, from loopback only"],
      },
      liveness: {
        method: "GET",
        path: "/health",
        owns: ["compatibility liveness witness"],
        doesNotOwn: [],
      },
    },
    forbiddenAuthority:
      "HTTP health, WebSocket decks, and JSON sidecars are compatibility/operator lowerings; they do not own daemon health or provider truth when CultCache/CultNet records exist.",
  };
}

function transportProfile() {
  return {
    schema: "gamecult.vili.transport_profile.v1",
    profileId: "vili",
    daemonId: "vili",
    targetTransport: "cultnet.transport.rudp.v0",
    currentTransport: "CultCache local state + compatibility HTTP/WS lowerings",
    state: "local-cultcache-only",
    providerAdvertisementSchema: "gamecult.eve.provider_advertisement.v1",
    operatorStateSchema: "gamecult.vili.operator_state.v1",
    commandBoundarySchema: "gamecult.vili.command_boundary.v1",
    compatibilityMechanisms: [
      `${ravenBaseUrl}/health`,
      `${ravenBaseUrl}/provider-advertisement`,
      `${ravenDeckUrl}/${providerId}`,
    ],
    cutLine:
      "Vili owns typed provider, operator, command, and transport state. HTTP/WS/JSON projections are lowerings until Odin consumes Vili provider records over CultNet/RUDP.",
    updatedAt: new Date().toISOString(),
  };
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
          { type: "stat", label: "Kimodo worker", value: state.backend.kimodoWorker },
          { type: "stat", label: "HF token", value: state.backend.huggingFaceToken },
          { type: "command", label: "Generate motion", method: "POST", href: `${ravenBaseUrl}/motion/generate` },
        ],
      },
    },
    state,
  };
}

async function persistSurfaces() {
  await mkdir(args.stateRoot, { recursive: true });
  await persistCultCacheSurfaces();
  await writeFile(path.join(args.stateRoot, "vili-daemon.pid"), `${process.pid}\n`);
  await writeFile(path.join(args.stateRoot, "provider-advertisement.json"), JSON.stringify(providerAdvertisement(), null, 2));
  await writeFile(path.join(args.stateRoot, "operator-state.json"), JSON.stringify(operatorState(), null, 2));
  await writeFile(path.join(args.stateRoot, "eve-operator-surface.json"), JSON.stringify(eveSurface(), null, 2));
  await writeFile(path.join(args.stateRoot, "command-boundary.json"), JSON.stringify(commandBoundary(), null, 2));
  await writeFile(path.join(args.stateRoot, "transport-profile.json"), JSON.stringify(transportProfile(), null, 2));
}

async function persistCultCacheSurfaces() {
  await viliCache.put(providerAdvertisementDefinition, providerId, providerAdvertisement());
  await viliCache.put(operatorStateDefinition, "vili", operatorState());
  await viliCache.put(eveSurfaceDefinition, providerId, eveSurface());
  await viliCache.put(commandBoundaryDefinition, "vili", commandBoundary());
  await viliCache.put(transportProfileDefinition, "vili", transportProfile());
}

// A read: it only asks. Starting docker and the worker belongs to a job that holds the GPU slot.
async function refreshBackendStatus() {
  const docker = await wsl("docker images gamecult/kimodo:latest --format '{{.Repository}}:{{.Tag}}' | head -n 1", { timeout: 20000 });
  const nvidia = await wsl("docker info --format '{{json .Runtimes}}' | grep -q nvidia && echo configured || echo missing", { timeout: 20000 });
  const token = await wsl("test -f /root/.cache/huggingface/token && echo present || echo missing", { timeout: 10000 });
  const worker = await kimodoWorkerHealth(20000);

  backendStatus = {
    checkedAt: new Date().toISOString(),
    dockerImage: docker.ok && docker.stdout ? docker.stdout : "missing",
    nvidiaRuntime: nvidia.ok && nvidia.stdout ? nvidia.stdout : "unavailable",
    huggingFaceToken: token.ok ? token.stdout : "unknown",
    kimodoWorker: worker.ok && worker.body?.ok ? "resident" : "not running",
    kimodoWorkerDetail: worker.body || null,
    lastError: [docker, nvidia, token].find((result) => !result.ok)?.stderr || null,
  };
  await persistSurfaces();
  return backendStatus;
}

async function kimodoWorkerHealth(timeout = 10000) {
  return wslJson(`curl -fsS --max-time ${Math.ceil(timeout / 1000)} ${shQuote(`${kimodoWorkerUrl}/health`)}`, { timeout });
}

async function startKimodoWorker({ model = null } = {}) {
  const script = [
    "set -e",
    "service docker start >/dev/null 2>&1 || true",
    dockerHuggingFaceEnv,
    "mkdir -p /mnt/e/Projects/Vili/.vili/artifacts /mnt/e/Projects/Vili/.vili/logs /mnt/e/Projects/Vili/.vili/embeddings",
    "export VILI_KIMODO_COMMIT=\"$(git -C /opt/gamecult/kimodo rev-parse HEAD)\"",
    "export VILI_KIMODO_IMAGE=\"$(docker image inspect --format '{{.Id}}' gamecult/kimodo:latest)\"",
    "if ! kill -0 $(cat /tmp/vili-wsl-keepalive.pid 2>/dev/null) >/dev/null 2>&1; then nohup bash -c 'while true; do sleep 3600; done' >/tmp/vili-wsl-keepalive.log 2>&1 & echo $! >/tmp/vili-wsl-keepalive.pid; fi",
    `if docker ps --format '{{.Names}}' | grep -qx ${shQuote(kimodoWorkerName)}; then echo running; exit 0; fi`,
    `docker rm -f ${shQuote(kimodoWorkerName)} >/dev/null 2>&1 || true`,
    [
      "docker run -d",
      `--name ${shQuote(kimodoWorkerName)}`,
      "--runtime=nvidia --gpus all",
      `-p 127.0.0.1:${kimodoWorkerPort}:${kimodoWorkerPort}`,
      dockerHuggingFaceArgs,
      "-e VILI_KIMODO_COMMIT -e VILI_KIMODO_IMAGE",
      "-e PYTHONPATH=/opt/cultlib/cultcache-py",
      "-v /mnt/e/Projects/Vili/scripts:/opt/vili:ro",
      "-v /mnt/e/Projects/CultLib/packages/cultcache-py/src:/opt/cultlib/cultcache-py:ro",
      "-v /mnt/e/Projects/Vili/.vili/embeddings:/vili-embeddings",
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

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// A state-changing POST is a service's or the tray's call, never a web page's. A browser sends a
// cross-site page's POST as a no-preflight simple request (text/plain) or with an Origin that is not
// ours, so both are refused before the body is read. The daemon grants no CORS preflight at all.
function refuseCrossSite(request, response) {
  const origin = request.headers.origin;
  const ownOrigins = [`http://127.0.0.1:${args.port}`, `http://localhost:${args.port}`, `http://[::1]:${args.port}`];
  const type = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type === "application/json" && (origin === undefined || ownOrigins.includes(origin))) return false;
  json(response, 403, { ok: false, code: "cross-site" });
  return true;
}

// The household's switch: only a caller on this machine (the tray, in the household's session) sets it.
async function setGpuPermission(request, response) {
  if (refuseCrossSite(request, response)) return;
  if (!loopbackAddresses.has(request.socket.remoteAddress)) {
    json(response, 403, { ok: false, code: "household-only" });
    return;
  }
  let body;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    json(response, 400, { ok: false, error: `Invalid JSON: ${error.message}` });
    return;
  }
  if (typeof body?.allowed !== "boolean") {
    json(response, 400, { ok: false, error: "allowed must be a boolean." });
    return;
  }
  json(response, 200, { ok: true, gpu: await gpuTenancy.setAllowed(body.allowed) });
}

async function generateMotion(request, response) {
  if (refuseCrossSite(request, response)) return;
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

  const admitted = await admitThen(gpuTenancy, () => runMotionJob(body, prompt, response));
  if (admitted?.code === "gpu-busy") {
    json(response, 503, admitted, { "retry-after": String(RETRY_AFTER_SECONDS) });
  }
}

async function runMotionJob(body, prompt, response) {
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
  const placement = result.ok ? null : placementRefusal(result.body, jobId);
  if (placement) json(response, 503, placement, { "retry-after": String(RETRY_AFTER_SECONDS) });
  else json(response, result.ok ? 200 : 502, job);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || `${hosts[0]}:${args.port}`}`);
  if (url.pathname === "/" || url.pathname === "/health") {
    await refreshBackendStatus();
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
  } else if (url.pathname === "/gpu-permission" && request.method === "GET") {
    json(response, 200, gpuTenancy.status());
  } else if (url.pathname === "/gpu-permission" && request.method === "POST") {
    await setGpuPermission(request, response);
  } else if (url.pathname === "/motion/generate" && request.method === "POST") {
    await generateMotion(request, response);
  } else {
    text(response, 404, "not found\n");
  }
}

async function healthCheck() {
  const response = await fetch(`http://${hosts[0]}:${args.port}/health`);
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
  if (hosts.length === 0 || hosts.includes("0.0.0.0") || hosts.includes("::")) {
    console.error("--host must name the addresses to listen on, never a wildcard.");
    process.exit(2);
  }
  await mkdir(path.join(args.stateRoot, "jobs"), { recursive: true });
  await persistSurfaces();

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    const sendSurface = () => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(eveSurface()));
    };
    sendSurface();
    const timer = setInterval(sendSurface, 5000);
    socket.on("close", () => clearInterval(timer));
  });

  const servers = hosts.map((host) => {
    const server = http.createServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        json(response, 500, { ok: false, error: error.message, stack: process.env.NODE_ENV === "development" ? error.stack : undefined });
      });
    });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host || `${hosts[0]}:${args.port}`}`);
      if (url.pathname === `/eve/deck/${providerId}` || url.pathname === "/eve/deck") {
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
      } else {
        socket.destroy();
      }
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.port, host, resolve);
    });
  });
  await Promise.all(servers);
  console.log(`Vili listening on ${hosts.map((host) => `http://${host}:${args.port}`).join(" ")}`);

  setInterval(() => persistSurfaces().catch((error) => console.error(error)), 5000);
}
