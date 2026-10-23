// node --test scripts/test-vili-daemon.mjs
// Runs the real daemon against scripts/fixtures/stub-worker.mjs as its --python/--worker-entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(here, "vili-daemon.mjs");
const stubPath = path.join(here, "fixtures", "stub-worker.mjs");
const THREADS = 5;

async function until(condition, what, seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await condition();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// A zombie is dead for our purposes: its parent (or init) has simply not reaped it yet.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

async function startDaemon({ omit = [], viaEnv = false, threads = String(THREADS), python = process.execPath, nested = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const stateRoot = nested ? path.join(root, "a", "b", "state") : root;
  const modelsRoot = path.join(root, "models");
  const settings = {
    host: "127.0.0.1",
    port: "0",
    "state-root": stateRoot,
    python,
    "worker-entry": stubPath,
    "models-root": modelsRoot,
    "kimodo-commit": "abc1234",
    "python-env": "test-env",
  };
  if (threads !== null) settings.threads = threads;
  for (const name of omit) delete settings[name];
  const env = { ...process.env, LEAK_CHECK: "leaked", LANG: "xx_TEST.UTF-8" };
  for (const name of Object.keys(env)) if (name.startsWith("VILI_")) delete env[name];
  const argv = [daemonPath];
  for (const [name, value] of Object.entries(settings)) {
    if (viaEnv) env[`VILI_${{ host: "DAEMON_HOST", port: "DAEMON_PORT", "state-root": "STATE_ROOT", "worker-entry": "WORKER_ENTRY" }[name] ?? name.toUpperCase().replace("-", "_")}`] = value;
    else argv.push(`--${name}`, value);
  }
  const proc = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { errors += chunk; });
  const port = await until(() => /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1], "the daemon to listen");
  const spawnLog = () => {
    const log = path.join(stateRoot, "embeddings", "stub-spawns.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  };
  return {
    stateRoot,
    modelsRoot,
    proc,
    port: Number(port),
    stderr: () => errors,
    spawns: () => spawnLog().filter((line) => /^\d+$/.test(line)).map(Number),
    grandchildren: () => spawnLog().filter((line) => line.startsWith("grandchild ")).map((line) => Number(line.split(" ")[1])),
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await until(() => proc.exitCode !== null || proc.signalCode !== null, "the daemon to exit", 30);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const generate = (daemon, payload = { prompt: "a person waves", duration: 2 }, headers = {}) =>
  request(daemon.port, "POST", "/motion/generate", {
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: { "content-type": "application/json", ...headers },
  });
const operatorState = async (daemon) => (await request(daemon.port, "GET", "/operator-state")).body;
const backendOf = async (daemon) => (await operatorState(daemon)).backend;

test("the worker's port comes from its ready line", async () => {
  const daemon = await startDaemon();
  try {
    const answer = await generate(daemon);
    assert.equal(answer.status, 200);
    const backend = await backendOf(daemon);
    assert.equal(backend.state, "ready");
    assert.notEqual(daemon.port, 8824, "--port 0 binds a free port");
    assert.ok(Number.isInteger(backend.port) && backend.port > 1 && backend.port !== 8825);
    assert.equal(answer.body.worker.pid, backend.pid);
    assert.deepEqual(answer.body.worker.argv.slice(-4), ["--host", "127.0.0.1", "--port", "0"]);
    // the request reached the stub on the port the stub printed, not on a decoy line's port
    assert.equal((await request(backend.port, "GET", "/health")).body.requests, 1);
  } finally {
    await daemon.stop();
  }
});

test("one child, respawned after exit", async () => {
  const daemon = await startDaemon();
  try {
    const [first, second] = await Promise.all([generate(daemon), generate(daemon)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(daemon.spawns().length, 1);
    const [pid] = daemon.spawns();
    process.kill(pid, "SIGKILL");
    await until(async () => (await backendOf(daemon)).state === "stopped", "the daemon to see the exit");
    assert.match((await backendOf(daemon)).lastError, /^the worker exited \(SIGKILL\)$/);
    const third = await generate(daemon);
    assert.equal(third.status, 200);
    const spawns = daemon.spawns();
    assert.equal(spawns.length, 2);
    assert.notEqual(spawns[1], pid);
    assert.equal(third.body.worker.pid, spawns[1]);
    assert.equal((await backendOf(daemon)).lastError, null);
  } finally {
    await daemon.stop();
  }
});

test("environment and nice", async () => {
  const daemon = await startDaemon();
  try {
    const { env, priority } = (await generate(daemon)).body.worker;
    assert.equal(env.OMP_NUM_THREADS, String(THREADS));
    assert.equal(env.MKL_NUM_THREADS, String(THREADS));
    assert.equal(env.VILI_THREADS, String(THREADS));
    assert.equal(env.HF_HUB_OFFLINE, "1");
    assert.equal(env.TRANSFORMERS_OFFLINE, "1");
    assert.equal(env.HF_HOME, daemon.modelsRoot);
    assert.equal(env.VILI_KIMODO_COMMIT, "abc1234");
    assert.equal(env.VILI_PYTHON_ENV, "test-env");
    assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
    assert.equal(env.PYTHONUNBUFFERED, "1");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.LANG, "xx_TEST.UTF-8");
    assert.ok(env.PYTHONPATH.endsWith(path.join("vendor", "CultLib", "packages", "cultcache-py", "src")));
    assert.equal(env.LEAK_CHECK, undefined, "the daemon's own environment does not reach the worker");
    assert.equal(priority, 10);
  } finally {
    await daemon.stop();
  }
});

test("every flag has an environment twin, and the thread cap defaults to 8", async () => {
  const viaEnv = await startDaemon({ viaEnv: true, threads: "16" });
  try {
    const answer = await generate(viaEnv);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.worker.env.OMP_NUM_THREADS, "16");
    assert.deepEqual(await backendOf(viaEnv), {
      state: "ready", pid: answer.body.worker.pid, port: (await backendOf(viaEnv)).port, threads: 16, pythonEnv: "test-env",
      kimodoCommit: "abc1234", modelsRoot: viaEnv.modelsRoot, lastError: null,
    });
  } finally {
    await viaEnv.stop();
  }
  const byDefault = await startDaemon({ threads: null });
  try {
    const answer = await generate(byDefault);
    assert.equal(answer.body.worker.env.OMP_NUM_THREADS, "8");
    assert.equal((await backendOf(byDefault)).threads, 8);
  } finally {
    await byDefault.stop();
  }
  const one = await startDaemon({ threads: "1", nested: true });
  try {
    assert.equal((await generate(one)).body.worker.env.OMP_NUM_THREADS, "1");
  } finally {
    await one.stop();
  }
});

test("the worker's output lands in its log, and the ready line does not", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await generate(daemon)).status, 200);
    const log = path.join(daemon.stateRoot, "logs", "worker.log");
    const text = await until(() => {
      const content = existsSync(log) ? readFileSync(log, "utf8") : "";
      return content.includes("stub-stdout-line") && content.includes("stub-stderr-line") ? content : null;
    }, "the worker log");
    assert.ok(!text.includes(`"port":${(await backendOf(daemon)).port}`), "the real ready line is not logged");
  } finally {
    await daemon.stop();
  }
});

test("a job is a record on disk", async () => {
  const daemon = await startDaemon();
  try {
    const answer = await generate(daemon, { prompt: "a person waves", duration: 2, constraints: [{ type: "root2d" }] });
    assert.equal(answer.status, 200);
    const job = answer.body;
    assert.equal(job.schema, "gamecult.vili.motion_job.v0");
    assert.equal(job.request.schema, "gamecult.vili.motion_request.v0");
    assert.equal(job.prompt, "a person waves");
    assert.equal(job.model, "stub-model");
    assert.equal(job.ok, true);
    assert.equal(job.error, null);
    assert.equal(job.artifactDir, path.join(daemon.stateRoot, "artifacts", job.jobId));
    assert.equal(job.worker.output, path.join(job.artifactDir, "motion"));
    assert.equal(job.worker.prompt, "a person waves");
    assert.equal(job.worker.constraints, path.join(job.artifactDir, "constraints.json"));
    assert.deepEqual(JSON.parse(readFileSync(job.worker.constraints, "utf8")), [{ type: "root2d" }]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(daemon.stateRoot, "jobs", `${job.jobId}.json`), "utf8")), job);
    const batch = await generate(daemon, { texts: ["a", "b"], durations: [1, 1] });
    assert.equal(batch.status, 200);
    assert.equal(batch.body.prompt, null);
    assert.equal(batch.body.worker.prompt, undefined);
  } finally {
    await daemon.stop();
  }
});

test("a requested model restarts the worker only when it is not the one serving", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await generate(daemon)).status, 200);
    assert.equal((await generate(daemon, { prompt: "x", model: "stub-model" })).status, 200);
    assert.equal((await generate(daemon, { prompt: "x", model: "Stub Model" })).status, 200);
    assert.equal(daemon.spawns().length, 1);
    const [first] = daemon.spawns();
    const other = await generate(daemon, { prompt: "x", model: "other-model" });
    assert.equal(other.status, 200);
    assert.equal(other.body.model, "other-model");
    assert.deepEqual(other.body.worker.argv.slice(-2), ["--model", "other-model"]);
    assert.equal(daemon.spawns().length, 2);
    await until(() => !isAlive(first), "the first worker to be gone");
    assert.equal((await generate(daemon)).status, 200);
    assert.equal(daemon.spawns().length, 2, "a request that names no model keeps the one serving");
  } finally {
    await daemon.stop();
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} leaves no child`, async () => {
    const daemon = await startDaemon();
    try {
      assert.equal((await generate(daemon)).status, 200);
      const [pid] = daemon.spawns();
      assert.ok(isAlive(pid));
      daemon.proc.kill(signal);
      await until(() => daemon.proc.exitCode !== null, "the daemon to exit");
      assert.equal(isAlive(pid), false);
    } finally {
      await daemon.stop();
    }
  });
}

test("a worker that ignores SIGTERM is killed with everything it started", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await generate(daemon, { prompt: "x", model: "stubborn" })).status, 200);
    const [pid] = daemon.spawns();
    const [grandchild] = daemon.grandchildren();
    assert.ok(isAlive(pid) && isAlive(grandchild));
    daemon.proc.kill("SIGTERM");
    await until(() => daemon.proc.exitCode !== null, "the daemon to exit", 30);
    assert.equal(isAlive(pid), false);
    assert.equal(isAlive(grandchild), false);
  } finally {
    await daemon.stop();
  }
});

test("cross-site is refused before the worker", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await generate(daemon)).status, 200);
    const withOrigin = await generate(daemon, undefined, { origin: "https://example.test" });
    assert.equal(withOrigin.status, 403);
    assert.deepEqual(withOrigin.body, { ok: false, code: "cross-site" });
    const plain = await generate(daemon, undefined, { "content-type": "text/plain" });
    assert.equal(plain.status, 403);
    assert.deepEqual(plain.body, { ok: false, code: "cross-site" });
    const untyped = await request(daemon.port, "POST", "/motion/generate", { body: JSON.stringify({ prompt: "x" }) });
    assert.equal(untyped.status, 403);
    const options = await request(daemon.port, "OPTIONS", "/motion/generate", { headers: { origin: "https://example.test" } });
    assert.equal(options.status, 404);
    const health = await request(daemon.port, "GET", "/health");
    for (const reply of [withOrigin, plain, untyped, options, health]) {
      assert.equal(Object.keys(reply.headers).filter((name) => name.startsWith("access-control-")).length, 0);
    }
    const backend = await backendOf(daemon);
    assert.equal((await request(backend.port, "GET", "/health")).body.requests, 1, "only the same-site request reached the worker");
    // the media type is matched as a type, not as a string
    assert.equal((await generate(daemon, undefined, { "content-type": "Application/JSON; charset=utf-8" })).status, 200);
  } finally {
    await daemon.stop();
  }
});

for (const omitted of ["models-root", "kimodo-commit", "python-env"]) {
  test(`unconfigured (no ${omitted}) refuses before spawning`, async () => {
    const daemon = await startDaemon({ omit: [omitted] });
    try {
      const answer = await generate(daemon);
      assert.equal(answer.status, 503);
      assert.deepEqual(answer.body, { ok: false, code: "worker-unconfigured" });
      assert.deepEqual(daemon.spawns(), []);
      assert.equal((await backendOf(daemon)).state, "stopped");
    } finally {
      await daemon.stop();
    }
  });
}

test("an error never echoes the request", async () => {
  const daemon = await startDaemon();
  try {
    const malformed = await generate(daemon, "{\"prompt\": \"the launch code is swordfish\", ");
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body, { ok: false, error: "Invalid JSON." });
    const missing = await generate(daemon, { texts: ["the launch code is swordfish"] });
    assert.equal(missing.status, 400);
    assert.ok(!missing.raw.includes("swordfish"));
    // a body the handler cannot use at all: the answer names nothing, and neither does the log
    const unusable = await generate(daemon, "null");
    assert.equal(unusable.status, 500);
    assert.deepEqual(unusable.body, { ok: false, code: "internal" });
    await until(() => daemon.stderr().includes("request failed: TypeError"), "the daemon to log the class");
    assert.ok(!daemon.stderr().includes("swordfish"));
  } finally {
    await daemon.stop();
  }
});

test("a worker that dies before it is ready fails the job, and the next job tries again", async () => {
  const daemon = await startDaemon();
  try {
    const failed = await generate(daemon, { prompt: "x", model: "crash-before-ready" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, "the worker request failed (Error)");
    const backend = await backendOf(daemon);
    assert.equal(backend.state, "failed");
    assert.equal(backend.lastError, "the worker exited (code 3)");
    assert.equal(backend.pid, null);
    assert.equal(backend.port, null);
    assert.equal((await generate(daemon)).status, 200);
    assert.equal((await backendOf(daemon)).state, "ready");
    assert.equal(daemon.spawns().length, 2);
  } finally {
    await daemon.stop();
  }
});

test("a worker that never says it is ready is killed at the deadline", async () => {
  const daemon = await startDaemon();
  try {
    const pending = generate(daemon, { prompt: "x", model: "hang-before-ready", workerTimeoutMs: 1500 });
    const starting = await until(async () => {
      const backend = await backendOf(daemon);
      return backend.state === "starting" ? backend : null;
    }, "the starting state");
    assert.ok(Number.isInteger(starting.pid) && starting.port === null);
    const failed = await pending;
    assert.equal(failed.status, 502);
    const backend = await backendOf(daemon);
    assert.equal(backend.state, "failed");
    assert.equal(backend.lastError, "the worker was not ready in time");
    assert.equal(isAlive(daemon.spawns()[0]), false);
  } finally {
    await daemon.stop();
  }
});

test("a worker that is ready but not healthy fails at the deadline; one that gets healthy in time serves", async () => {
  const daemon = await startDaemon();
  try {
    const failed = await generate(daemon, { prompt: "x", model: "sick", workerTimeoutMs: 1500 });
    assert.equal(failed.status, 502);
    const backend = await backendOf(daemon);
    assert.equal(backend.state, "failed");
    assert.equal(backend.lastError, "the worker did not become healthy in time");
    assert.equal(isAlive(daemon.spawns()[0]), false);
    const slow = await generate(daemon, { prompt: "x", model: "slow-health" });
    assert.equal(slow.status, 200);
    assert.equal((await backendOf(daemon)).state, "ready");
  } finally {
    await daemon.stop();
  }
});

test("a missing interpreter fails the job at once", async () => {
  const daemon = await startDaemon({ python: "/no/such/python" });
  try {
    const began = Date.now();
    const failed = await generate(daemon);
    assert.equal(failed.status, 502);
    assert.ok(Date.now() - began < 5000, "nothing waits on a process that never existed");
    const backend = await backendOf(daemon);
    assert.equal(backend.state, "failed");
    assert.equal(backend.lastError, "the worker could not be spawned");
  } finally {
    await daemon.stop();
  }
});

test("a worker that refuses, errors or drops the request fails the job without echoing it", async () => {
  const daemon = await startDaemon();
  try {
    const refused = await generate(daemon, { prompt: "swordfish", model: "refuse-generate" });
    assert.equal(refused.status, 502);
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.error, null);
    const errored = await generate(daemon, { prompt: "swordfish", model: "fail-generate" });
    assert.equal(errored.status, 502);
    assert.equal(errored.body.error, "the worker answered 500");
    const dropped = await generate(daemon, { prompt: "swordfish", model: "drop-generate" });
    assert.equal(dropped.status, 502);
    assert.equal(dropped.body.error, "the worker request failed (TypeError)");
    const stalled = await generate(daemon, { prompt: "swordfish", model: "slow-generate", timeoutMs: 700 });
    assert.equal(stalled.status, 502);
    assert.equal(stalled.body.error, "the worker request failed (TimeoutError)");
    for (const answer of [refused, errored, dropped, stalled]) assert.ok(!answer.body.error?.includes("swordfish"));
  } finally {
    await daemon.stop();
  }
});

test("health, operator state and the unknown", async () => {
  const daemon = await startDaemon();
  try {
    for (const route of ["/", "/health"]) {
      const answer = await request(daemon.port, "GET", route);
      assert.equal(answer.status, 200);
      assert.equal(answer.body.ok, true);
      assert.equal(answer.body.service, "vili");
      assert.equal(answer.body.state.backend.threads, THREADS);
    }
    assert.equal((await request(daemon.port, "GET", "/motion/generate")).status, 404);
    const unknown = await request(daemon.port, "GET", "/eve/operator");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.raw, "not found\n");
    const state = await operatorState(daemon);
    assert.equal(state.host, os.hostname());
    assert.deepEqual(Object.keys(state.routes), ["health", "operatorState", "generate"]);
  } finally {
    await daemon.stop();
  }
});

test("the typed service state is refreshed while the daemon runs", async () => {
  const daemon = await startDaemon({ nested: true });
  try {
    const store = path.join(daemon.stateRoot, "vili.service.cc");
    assert.ok(existsSync(store));
    assert.ok(!readFileSync(store).includes("ready"));
    assert.equal((await generate(daemon)).status, 200);
    await until(() => readFileSync(store).includes("ready"), "the store to show the worker ready", 20);
  } finally {
    await daemon.stop();
  }
});

test("--health asks a running daemon, and fails when there is none", async () => {
  const daemon = await startDaemon();
  const check = (port) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [daemonPath, "--health", "--host", "127.0.0.1", "--port", String(port)], { stdio: "ignore" });
    proc.on("exit", resolve);
  });
  try {
    assert.equal(await check(daemon.port), 0);
    const gone = daemon.port;
    await daemon.stop();
    assert.equal(await check(gone), 1);
  } finally {
    await daemon.stop();
  }
});

test("a thread count outside 1 to 16 stops the daemon without echoing it", async () => {
  for (const threads of ["0", "17", "99", "100", "8x", "x8", "-1", "1.5"]) {
    const proc = spawn(process.execPath, [daemonPath, "--threads", threads], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk; });
    proc.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => proc.on("exit", resolve));
    assert.equal(code, 2);
    assert.match(output, /threads must be an integer from 1 to 16/);
    assert.ok(!output.replace("from 1 to 16", "").includes(threads), `the refusal repeated ${threads}`);
  }
});
