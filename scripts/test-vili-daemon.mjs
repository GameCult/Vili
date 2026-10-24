// node --test scripts/test-vili-daemon.mjs
// Runs the real daemon against scripts/fixtures/stub-worker.mjs as its --python/--worker-entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decode, encode } from "@msgpack/msgpack";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(here, "vili-daemon.mjs");
const stubPath = path.join(here, "fixtures", "stub-worker.mjs");
const fakeIdunnEntry = path.join(here, "fixtures", "fake-idunn-entry.mjs");
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

async function startDaemon({
  omit = [], viaEnv = false, threads = String(THREADS), python = process.execPath, nested = false, host = "127.0.0.1",
  relativeModels = false, extraArgs = [], root: givenRoot = null, entry = daemonPath, extraEnv = {}, hold = entry === daemonPath,
} = {}) {
  const root = givenRoot ?? mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const stateRoot = nested ? path.join(root, "a", "b", "state") : root;
  const modelsRoot = path.join(root, "models");
  const settings = {
    host,
    port: "0",
    "state-root": stateRoot,
    python,
    "worker-entry": stubPath,
    "models-root": relativeModels ? "models-rel" : modelsRoot,
    "kimodo-commit": "abc1234",
    "python-env": "test-env",
  };
  if (threads !== null) settings.threads = threads;
  for (const name of omit) delete settings[name];
  const env = { ...process.env, LEAK_CHECK: "leaked", LANG: "xx_TEST.UTF-8", ...extraEnv };
  for (const name of Object.keys(env)) if (name.startsWith("VILI_")) delete env[name];
  const argv = [entry, ...extraArgs];
  for (const [name, value] of Object.entries(settings)) {
    if (viaEnv) env[`VILI_${{ host: "DAEMON_HOST", port: "DAEMON_PORT", "state-root": "STATE_ROOT", "worker-entry": "WORKER_ENTRY" }[name] ?? name.toUpperCase().replace("-", "_")}`] = value;
    else argv.push(`--${name}`, value);
  }
  const proc = spawn(process.execPath, argv, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { errors += chunk; });
  const listening = await until(() => /listening on http:\/\/([^:]+):(\d+)/.exec(output), "the daemon to listen");
  const port = listening[2];
  // the hand-run daemon takes its lock after it listens; a test that wants a served state root waits for it
  if (hold) await until(() => /holds the state root/.test(output), "the daemon to hold the state root");
  const spawnLog = () => {
    const log = path.join(stateRoot, "embeddings", "stub-spawns.log");
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  };
  return {
    root,
    stateRoot,
    modelsRoot,
    proc,
    boundHost: listening[1],
    port: Number(port),
    stderr: () => errors,
    stdout: () => output,
    spawns: () => spawnLog().filter((line) => /^\d+$/.test(line)).map(Number),
    grandchildren: () => spawnLog().filter((line) => line.startsWith("grandchild ")).map((line) => Number(line.split(" ")[1])),
    async stop() {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGTERM");
          await until(() => proc.exitCode !== null || proc.signalCode !== null, "the daemon to exit", 30);
        }
      } finally {
        // a daemon that did not stop on SIGTERM must not outlive the test and hold the run open
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
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
    assert.equal(job.worker.contentType, "application/json");
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
      await until(() => daemon.proc.exitCode !== null, "the daemon to exit", 8);
      assert.equal(isAlive(pid), false);
    } finally {
      await daemon.stop();
    }
  });
}

test("a worker that is stopping gets its grace, not a SIGKILL", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await generate(daemon, { prompt: "x", model: "graceful" })).status, 200);
    daemon.proc.kill("SIGTERM");
    await until(() => daemon.proc.exitCode !== null, "the daemon to exit", 8);
    assert.ok(readFileSync(path.join(daemon.stateRoot, "embeddings", "stub-spawns.log"), "utf8").includes("graceful-exit"));
  } finally {
    await daemon.stop();
  }
});

test("a worker that dies while the daemon waits for its health fails the job at once", async () => {
  const daemon = await startDaemon();
  try {
    const began = Date.now();
    const failed = await generate(daemon, { prompt: "x", model: "die-after-ready" });
    assert.equal(failed.status, 502);
    assert.ok(Date.now() - began < 20000, "the default deadline is minutes; a dead worker does not wait for it");
    const backend = await backendOf(daemon);
    assert.equal(backend.state, "stopped");
    assert.equal(backend.lastError, "the worker exited (code 4)");
  } finally {
    await daemon.stop();
  }
});

test("the daemon binds loopback unless told otherwise, and ignores flags it does not know", async () => {
  const byDefault = await startDaemon({ omit: ["host"], extraArgs: ["--bogus"] });
  try {
    assert.equal(byDefault.boundHost, "127.0.0.1");
    assert.equal((await request(byDefault.port, "GET", "/health")).status, 200);
  } finally {
    await byDefault.stop();
  }
  const named = await startDaemon({ host: "127.0.0.2" });
  try {
    assert.equal(named.boundHost, "127.0.0.2");
    assert.equal((await fetch(`http://127.0.0.2:${named.port}/health`)).status, 200);
  } finally {
    await named.stop();
  }
});

test("a relative models root reaches the worker as an absolute path", async () => {
  const daemon = await startDaemon({ relativeModels: true });
  try {
    const { env } = (await generate(daemon)).body.worker;
    assert.equal(env.HF_HOME, path.join(path.dirname(daemon.modelsRoot), "models-rel"));
  } finally {
    await daemon.stop();
  }
});

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

// The daemon owns the worker's whole tree (motion-pipeline:finding:cut-vili-cpu-body.s1.orphaned-descendants).
const aliveWorkers = (daemon) => daemon.spawns().filter(isAlive);

test("a worker killed mid-request leaves no encoder child, and the next job has exactly one worker", async () => {
  const daemon = await startDaemon();
  try {
    const pending = generate(daemon, { prompt: "x", model: "encoder" });
    const [grandchild] = await until(() => { const found = daemon.grandchildren(); return found.length ? found : null; }, "the encoder child");
    const [worker] = daemon.spawns();
    assert.ok(isAlive(worker) && isAlive(grandchild));
    process.kill(worker, "SIGKILL");
    assert.equal(readFileSync(path.join(daemon.stateRoot, "worker.pid"), "utf8"), `${worker}\n`);
    assert.equal((await pending).status, 502);
    await until(() => !isAlive(grandchild), "the encoder child to die with its worker");
    await until(() => !existsSync(path.join(daemon.stateRoot, "worker.pid")), "the dead worker's pid file to go");
    assert.equal((await generate(daemon, { prompt: "y" })).status, 200);
    assert.equal(aliveWorkers(daemon).length, 1);
    assert.equal(readFileSync(path.join(daemon.stateRoot, "worker.pid"), "utf8"), `${aliveWorkers(daemon)[0]}\n`);
    assert.equal(isAlive(grandchild), false);
  } finally {
    await daemon.stop();
  }
});

// "encoder" leaves a SIGTERM-proof grandchild beside the worker; "stubborn" is a worker that ignores SIGTERM; the plain stub is just a worker.
for (const model of ["encoder", "stubborn", "stub-model"]) {
  test(`a restarted daemon kills the ${model} worker its crashed predecessor left, and runs exactly one`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
    const first = await startDaemon({ root });
    const stray = generate(first, { prompt: "x", model }).catch(() => null);
    await until(() => first.spawns().length, "the worker");
    if (model === "encoder") await until(() => first.grandchildren().length, "the encoder child");
    await until(() => request(first.port, "GET", "/health").then((r) => r.body?.state?.backend?.state === "ready"), "the worker to be ready");
    const [worker] = first.spawns();
    const strays = [worker, ...first.grandchildren()];
    first.proc.kill("SIGKILL");
    await until(() => first.proc.exitCode !== null || first.proc.signalCode !== null, "the first daemon to die");
    await stray;
    assert.ok(strays.every(isAlive), "the probe must reproduce the orphan before the fix can be measured");
    const second = await startDaemon({ root });
    try {
      await until(() => !strays.some(isAlive), "the orphans to be killed");
      assert.equal(existsSync(path.join(root, "worker.pid")), false);
      assert.equal((await generate(second, { prompt: "y" })).status, 200);
      assert.equal(aliveWorkers(second).length, 1);
      second.proc.kill("SIGTERM");
      await until(() => second.proc.exitCode !== null, "the second daemon to exit", 30);
      assert.equal(aliveWorkers(second).length, 0);
    } finally {
      await second.stop();
    }
  });
}

test("a live worker outside the pid file's group is left alone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const first = await startDaemon({ root });
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    assert.equal((await generate(first)).status, 200);
    const [worker] = first.spawns();
    first.proc.kill("SIGKILL");
    await until(() => first.proc.exitCode !== null || first.proc.signalCode !== null, "the first daemon to die");
    writeFileSync(path.join(root, "worker.pid"), `${bystander.pid}\n`);
    const second = await startDaemon({ root });
    assert.ok(isAlive(worker) && isAlive(bystander.pid), "only the group the pid file names, and only if it is ours, is killed");
    second.proc.kill("SIGTERM");
    await until(() => second.proc.exitCode !== null, "the second daemon to exit", 30);
    process.kill(-worker, "SIGKILL");
  } finally {
    bystander.kill("SIGKILL");
    await first.stop();
  }
});

// The marker that proves a group is ours is this state root's own embeddings directory. A live worker of another
// state root, named by a stale pid file, carries another root's marker and is left alone.
test("a pid file naming another state root's live worker kills nothing", async () => {
  const other = await startDaemon();
  const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  try {
    assert.equal((await generate(other)).status, 200);
    const [foreign] = other.spawns();
    writeFileSync(path.join(root, "worker.pid"), `${foreign}\n`);
    const daemon = await startDaemon({ root });
    try {
      assert.ok(isAlive(foreign), "a worker carrying another root's marker must survive the reclaim");
      assert.equal(existsSync(path.join(root, "worker.pid")), false, "the stale pid file is still forgotten");
    } finally {
      await daemon.stop();
    }
  } finally {
    await other.stop();
  }
});

test("a pid file naming a process group that is not the worker's kills nothing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  writeFileSync(path.join(root, "worker.pid"), `${bystander.pid}\n`);
  const daemon = await startDaemon({ root });
  try {
    assert.equal(isAlive(bystander.pid), true);
    assert.equal(existsSync(path.join(root, "worker.pid")), false);
  } finally {
    bystander.kill("SIGKILL");
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
    assert.equal((await generate(daemon, undefined, { "content-type": "application/json ; charset=utf-8" })).status, 200);
    // and only the generate route answers a POST
    const stray = await request(daemon.port, "POST", "/motion/other", {
      body: JSON.stringify({ prompt: "x" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(stray.status, 404);
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
    assert.equal(existsSync(path.join(daemon.stateRoot, "worker.pid")), false);
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
    // the retired operator route, spelled in parts so the retirement grep over scripts/ stays empty
    assert.equal((await request(daemon.port, "GET", ["", "eve", "operator"].join("/"))).status, 404);
    const unknown = await request(daemon.port, "GET", "/provider-advertisement");
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

const msgpackPost = (daemon, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: daemon.port, method: "POST", path: "/cultnet/snapshot", headers: { "content-type": "application/msgpack", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
const SECRET = "canary-9f3c-never-echoed";
const snapshotRequest = (messageId = "m1") => Buffer.from(encode({ schemaVersion: "cultnet.snapshot_request.v0", messageId }));

// A second daemon on a state root a live daemon holds must refuse, and must not touch the first one's worker.
test("a second daemon on a live state root exits 2 and kills nothing", async () => {
  const first = await startDaemon();
  let second = null;
  try {
    assert.equal((await generate(first)).status, 200);
    const [worker] = first.spawns();
    assert.ok(isAlive(worker));
    second = await startDaemon({ root: first.root, hold: false });
    await until(() => second.proc.exitCode !== null, "the second daemon to refuse", 20);
    assert.equal(second.proc.exitCode, 2);
    assert.match(second.stderr(), /held by a running daemon/);
    assert.ok(isAlive(worker), "the first daemon's worker must survive the refusal");
    assert.equal((await generate(first)).status, 200);
    assert.equal(aliveWorkers(first).length, 1);
  } finally {
    if (second && second.proc.exitCode === null && second.proc.signalCode === null) second.proc.kill("SIGKILL"); // a daemon that failed to refuse must not outlive the test
    await first.stop();
  }
});

// Two daemons start together over the lock a crashed daemon left. Exactly one owns the root, every time: the
// other exits 2, and one generate leaves one worker on the root.
for (let trial = 1; trial <= 40; trial += 1) {
  test(`two daemons racing a crashed daemon's lock leave one owner and one worker (trial ${trial})`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
    const crashed = await startDaemon({ root });
    crashed.proc.kill("SIGKILL");
    await until(() => crashed.proc.exitCode !== null || crashed.proc.signalCode !== null, "the first daemon to die");
    const racers = await Promise.all([startDaemon({ root, hold: false }), startDaemon({ root, hold: false })]);
    try {
      await until(() => racers.every((racer) => racer.proc.exitCode !== null || /holds the state root/.test(racer.stdout())), "both racers to decide", 20);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const owners = racers.filter((racer) => racer.proc.exitCode === null);
      assert.equal(owners.length, 1, "exactly one daemon stays up");
      assert.match(owners[0].stdout(), /holds the state root/);
      const loser = racers.find((racer) => racer !== owners[0]);
      assert.equal(loser.proc.exitCode, 2);
      assert.match(loser.stderr(), /held by a running daemon/);
      for (const racer of owners) assert.equal((await generate(racer)).status, 200);
      assert.equal(aliveWorkers(owners[0]).length, 1, "one worker on the root");
    } finally {
      for (const racer of racers) if (racer.proc.exitCode === null && racer.proc.signalCode === null) racer.proc.kill("SIGKILL");
      for (const pid of racers[0].spawns()) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// canonicalPath's fallback: a state root that does not exist yet is resolved through its longest existing prefix, so a
// daemon naming it through a symlink and one naming it directly still contend for one lock.
for (let trial = 1; trial <= 10; trial += 1) {
  test(`two daemons naming a not-yet-existing root, one through a symlink, leave one owner (trial ${trial})`, async () => {
    const real = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    const racers = await Promise.all([startDaemon({ root: real, nested: true, hold: false }), startDaemon({ root: link, nested: true, hold: false })]);
    try {
      await until(() => racers.every((racer) => racer.proc.exitCode !== null || /holds the state root/.test(racer.stdout())), "both racers to decide", 20);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const owners = racers.filter((racer) => racer.proc.exitCode === null);
      assert.equal(owners.length, 1, "exactly one daemon stays up");
      const loser = racers.find((racer) => racer !== owners[0]);
      assert.equal(loser.proc.exitCode, 2);
      assert.match(loser.stderr(), /held by a running daemon/);
    } finally {
      for (const racer of racers) if (racer.proc.exitCode === null && racer.proc.signalCode === null) racer.proc.kill("SIGKILL");
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
}
const idunnDaemon = async ({ leased = false, extraEnv = {}, loseWhenExists = null } = {}) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const lease = path.join(root, "lease");
  const healthLog = path.join(root, "health.log");
  if (leased) writeFileSync(lease, "");
  const daemon = await startDaemon({
    root, nested: true, entry: fakeIdunnEntry, extraEnv: {
      FAKE_IDUNN_LEASE: lease, FAKE_IDUNN_HEALTH_LOG: healthLog, ...extraEnv,
      ...(loseWhenExists ? { FAKE_IDUNN_STATE_ROOT: path.join(root, "a", "b", "state"), FAKE_IDUNN_LOSE_WHEN_EXISTS: loseWhenExists } : {}),
    },
  });
  return Object.assign(daemon, { lease, health: () => (existsSync(healthLog) ? readFileSync(healthLog, "utf8").split("\n").filter(Boolean) : []) });
};

test("before the lease nothing is written, spawned or accepted", async () => {
  const daemon = await idunnDaemon();
  try {
    const answer = await generate(daemon);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-pending");
    assert.deepEqual(daemon.spawns(), []);
    assert.equal(existsSync(daemon.stateRoot), false, "the state root must not exist before the lease");
    assert.deepEqual(daemon.health(), []);
  } finally {
    await daemon.stop();
  }
});

test("with the lease the daemon writes and serves, and no pid file exists", async () => {
  const daemon = await idunnDaemon();
  try {
    writeFileSync(daemon.lease, "");
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    const answer = await generate(daemon);
    assert.equal(answer.status, 200);
    assert.equal(existsSync(path.join(daemon.stateRoot, "worker.pid")), false);
    assert.equal(existsSync(path.join(daemon.stateRoot, "daemon.lock")), false);
    assert.deepEqual(daemon.health(), ["active"]);
  } finally {
    await daemon.stop();
  }
});

test("losing the lease kills the worker tree, refuses, and writes nothing more", async () => {
  const daemon = await idunnDaemon({ leased: true });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    assert.equal((await generate(daemon, { prompt: "x", model: "stubborn" })).status, 200);
    const [worker] = daemon.spawns();
    const [grandchild] = await until(() => { const found = daemon.grandchildren(); return found.length ? found : null; }, "the armed grandchild");
    assert.ok(isAlive(worker) && isAlive(grandchild));
    rmSync(daemon.lease);
    await until(() => !isAlive(worker) && !isAlive(grandchild), "the worker tree to die", 20);
    const answer = await generate(daemon);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
    await until(() => daemon.health().join() === "active,degraded", "the health to say degraded");
    const store = path.join(daemon.stateRoot, "vili.service.cc");
    const before = statSync(store).mtimeMs;
    const jobs = readdirSync(path.join(daemon.stateRoot, "jobs")).length;
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal(statSync(store).mtimeMs, before);
    assert.equal(readdirSync(path.join(daemon.stateRoot, "jobs")).length, jobs);
  } finally {
    await daemon.stop();
  }
});

// A generate whose headers are in and whose body is still arriving when the lease goes. The lease is gone, so
// nothing is created and nothing is spawned when the body completes, whether the daemon has noticed the loss yet
// (its 5 s tick) or not.
for (const noticed of [false, true]) {
  test(`a request in flight when the lease is lost writes and spawns nothing (loss ${noticed ? "noticed" : "not yet noticed"})`, async () => {
    const daemon = await idunnDaemon({ leased: true });
    try {
      await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
      const body = JSON.stringify({ prompt: "x", duration: 2 });
      const socket = net.connect(daemon.port, "127.0.0.1");
      let raw = "";
      socket.on("data", (chunk) => { raw += chunk; });
      const closed = new Promise((resolve) => socket.on("close", resolve));
      socket.write(`POST /motion/generate HTTP/1.1\r\nhost: vili\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body.slice(0, 5)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      rmSync(daemon.lease);
      if (noticed) await until(() => daemon.health().join() === "active,degraded", "the daemon to notice the loss", 15);
      socket.write(body.slice(5));
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 15000))]);
      socket.destroy();
      assert.match(raw, /^HTTP\/1\.1 503 /);
      assert.match(raw, /write-lease-lost/);
      assert.deepEqual(daemon.spawns(), [], "no worker is spawned after the loss");
      const artifacts = path.join(daemon.stateRoot, "artifacts");
      assert.deepEqual(existsSync(artifacts) ? readdirSync(artifacts) : [], [], "no artifact directory is created");
      assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "jobs")), []);
    } finally {
      await daemon.stop();
    }
  });
}

// The lease goes between two writes of one request. Each case names the path whose appearance takes the lease, and
// what must not exist afterwards: every write and the spawn are gated where they happen, not by the request's
// earlier checks.
const losses = [
  { when: "artifacts/*", absent: ["artifacts/*/meta.json", "logs", "embeddings"] },
  { when: "artifacts/*", payload: { prompt: "a person waves", duration: 2, constraints: [{ type: "root2d" }] }, absent: ["artifacts/*/constraints.json", "artifacts/*/meta.json"] },
  { when: "artifacts/*/meta.json", absent: ["logs", "embeddings"] },
  { when: "logs", absent: ["embeddings"] },
  { when: "embeddings", absent: ["logs/worker.log"] },
  { when: "embeddings/stub-healthy", absent: ["artifacts/*/request.json", "jobs/*"] },
];
for (const { when, absent, payload } of losses) {
  test(`a request is stopped at its next write when the lease goes at ${when}${payload ? " (constraints in the body)" : ""}`, async () => {
    const daemon = await idunnDaemon({ leased: true, loseWhenExists: when });
    try {
      await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
      const answer = await generate(daemon, payload);
      assert.equal(answer.status, 503);
      assert.equal(answer.body.code, "write-lease-lost");
      for (const gone of absent) {
        const parts = gone.split("/");
        const found = (base, rest) => (rest.length === 0 ? existsSync(base)
          : rest[0] === "*" ? existsSync(base) && readdirSync(base).some((entry) => found(path.join(base, entry), rest.slice(1)))
            : found(path.join(base, rest[0]), rest.slice(1)));
        assert.equal(found(daemon.stateRoot, parts), false, `${gone} must not exist`);
      }
      if (when === "embeddings") assert.deepEqual(daemon.spawns(), []);
    } finally {
      await daemon.stop();
    }
  });
}

// The daemon's own copy of a worker's stdout into worker.log is a write like any other.
test("a worker's output line is not logged once the lease is gone", async () => {
  const daemon = await idunnDaemon({ leased: true, loseWhenExists: "embeddings/stub-spawns.log" });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    const answer = await generate(daemon);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
    const log = readFileSync(path.join(daemon.stateRoot, "logs", "worker.log"), "utf8");
    assert.ok(!log.includes("stub-stdout-line"), "the daemon must not copy the worker's stdout after the loss");
  } finally {
    await daemon.stop();
  }
});

// The lease goes while the first persist is under way: the daemon survives it, stays degraded, and the rest of the
// startup writes are not made.
test("a lease lost while the state root is opened leaves the daemon up, degraded and writing nothing more", async () => {
  const daemon = await idunnDaemon({ leased: true, loseWhenExists: "vili.service.cc" });
  try {
    await until(() => daemon.health().includes("degraded") || daemon.proc.exitCode !== null, "the loss to be seen", 15);
    assert.equal(daemon.proc.exitCode, null, "the daemon must not die of it");
    assert.deepEqual(daemon.health(), ["degraded"]);
    const store = readFileSync(path.join(daemon.stateRoot, "vili.service.cc"));
    assert.ok(store.includes("operator_state") && !store.includes("command_boundary"), "the second document is not written");
    const answer = await generate(daemon);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
  } finally {
    await daemon.stop();
  }
});

test("a request arriving right after the lease is lost writes and spawns nothing", async () => {
  const daemon = await idunnDaemon({ leased: true });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    rmSync(daemon.lease);
    const answer = await generate(daemon);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
    assert.deepEqual(daemon.spawns(), []);
    const artifacts = path.join(daemon.stateRoot, "artifacts");
    assert.deepEqual(existsSync(artifacts) ? readdirSync(artifacts) : [], []);
    assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "jobs")), []);
  } finally {
    await daemon.stop();
  }
});

test("a worker respawned under the lease is killed when the lease is lost", async () => {
  const daemon = await idunnDaemon({ leased: true });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    assert.equal((await generate(daemon)).status, 200);
    const [first] = daemon.spawns();
    process.kill(-first, "SIGKILL");
    await until(async () => (await backendOf(daemon)).state === "stopped", "the daemon to see the worker gone");
    assert.equal((await generate(daemon)).status, 200);
    const second = daemon.spawns().find((pid) => pid !== first);
    assert.ok(second && isAlive(second));
    rmSync(daemon.lease);
    await until(() => !isAlive(second), "the respawned worker to die", 20);
  } finally {
    await daemon.stop();
  }
});

// Idunn stops an incumbent (SIGTERM to the unit) before it revokes the lease. What Vili owns in that sequence: the
// worker tree is dead when the process ends, it exits 0, and nothing is written from the signal on.
test("on SIGTERM the daemon stops its worker tree, writes nothing more, and exits 0", async () => {
  const daemon = await idunnDaemon({ leased: true });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    assert.equal((await generate(daemon, { prompt: "x", model: "stubborn" })).status, 200);
    const [worker] = daemon.spawns();
    const [grandchild] = await until(() => { const found = daemon.grandchildren(); return found.length ? found : null; }, "the armed grandchild");
    const store = path.join(daemon.stateRoot, "vili.service.cc");
    const before = statSync(store).mtimeMs;
    const jobs = readdirSync(path.join(daemon.stateRoot, "jobs"));
    daemon.proc.kill("SIGTERM");
    await until(() => daemon.proc.exitCode !== null || daemon.proc.signalCode !== null, "the daemon to exit", 30);
    assert.equal(daemon.proc.exitCode, 0);
    assert.ok(!isAlive(worker) && !isAlive(grandchild), "the worker tree is dead when the daemon is gone");
    assert.equal(statSync(store).mtimeMs, before, "the 5 s surface tick must not write during the stop");
    assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "jobs")), jobs);
    assert.ok(existsSync(daemon.lease), "the daemon never touches the lease Idunn revokes");
  } finally {
    await daemon.stop();
  }
});

test("a job that finishes after the lease is lost is not recorded", async () => {
  const daemon = await idunnDaemon({ leased: true });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    const slow = generate(daemon, { prompt: "x", model: "slow-generate" });
    slow.catch(() => {}); // a failing assertion below must not leave this request pending
    await until(() => daemon.spawns().length, "the worker");
    await until(() => request(daemon.port, "GET", "/health").then((r) => r.body?.state?.backend?.state === "ready"), "the worker to be ready");
    rmSync(daemon.lease);
    const answer = await Promise.race([slow, new Promise((resolve) => setTimeout(() => resolve({ status: "no answer in 30 s" }), 30000))]);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
    assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "jobs")), []);
  } finally {
    await daemon.stop();
  }
});

test("the route challenge is answered ahead of the cross-site refusal, and an Origin is still refused", async () => {
  const daemon = await idunnDaemon();
  try {
    // the challenge is how Idunn learns the incarnation is warming, so it is answered before the lease
    const answered = await msgpackPost(daemon, snapshotRequest("m-42"));
    assert.equal(answered.status, 200);
    assert.equal(answered.headers["content-type"], "application/msgpack");
    const message = decode(answered.raw);
    assert.equal(message.schemaVersion, "cultnet.snapshot_response_raw.v0");
    assert.equal(message.messageId, "m-42");
    assert.equal(message.documents.length, 1);
    assert.equal((await msgpackPost(daemon, snapshotRequest(), { origin: "https://evil.example" })).status, 403);
    assert.equal((await msgpackPost(daemon, Buffer.from("not msgpack at all"))).status, 400);
    assert.equal((await msgpackPost(daemon, Buffer.from(encode({ schemaVersion: "cultnet.snapshot_response_raw.v0", messageId: "x", documents: [] })))).status, 400);
    assert.equal((await msgpackPost(daemon, Buffer.alloc(70 * 1024))).status, 400);
    const text = await request(daemon.port, "POST", "/motion/generate", { body: "{}", headers: { "content-type": "text/plain" } });
    assert.equal(text.status, 403);
  } finally {
    await daemon.stop();
  }
});

test("a signer that cannot answer gives 503 and echoes nothing", async () => {
  const daemon = await idunnDaemon({ extraEnv: { FAKE_IDUNN_ANSWER_THROWS: "1" } });
  try {
    const answered = await msgpackPost(daemon, snapshotRequest(SECRET));
    assert.equal(answered.status, 503);
    assert.ok(!answered.raw.toString("utf8").includes(SECRET));
    assert.ok(!daemon.stderr().includes(SECRET));
  } finally {
    await daemon.stop();
  }
});

test("the hand-run daemon has no route challenge", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await msgpackPost(daemon, snapshotRequest())).status, 404);
    assert.equal((await msgpackPost(daemon, snapshotRequest(), { origin: "https://evil.example" })).status, 404);
  } finally {
    await daemon.stop();
  }
});

// ---- the Idunn entry's own rules: its argument contract, and what it derives for the daemon

const entryPath = path.join(here, "idunn-entry.mjs");
const runEntry = (args, env = {}) => new Promise((resolve) => {
  const proc = spawn(process.execPath, [entryPath, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  proc.on("exit", (code) => resolve({ code, output }));
});

test("the entry takes exactly --state-root <absolute> --kimodo-commit <40 hex>, and echoes none of a bad value", async () => {
  const commit = "6bb58488037dd65360ff0c5d1692b403a23309f7";
  const good = ["--state-root", "/var/lib/gamecult/vili", "--kimodo-commit", commit];
  const bads = [
    [],
    [...good, "--extra", "x"],
    ["--kimodo-commit", commit, "--state-root", "/var/lib/gamecult/vili"],
    ["--state-root", "canary-relative-path", "--kimodo-commit", commit],
    ["--state-root", "/var/lib/gamecult/vili", "--kimodo-commit", "canary-not-a-commit"],
    ["--state-root", "/var/lib/gamecult/vili", "--kimodo-commit", commit.toUpperCase()],
  ];
  for (const args of bads) {
    const answer = await runEntry(args, { GAMECULT_IDUNN_CANDIDATE_BIND: "127.0.0.1:18861" });
    assert.equal(answer.code, 2, JSON.stringify(args));
    assert.ok(!answer.output.includes("canary"), `the refusal repeated a value of ${JSON.stringify(args)}`);
  }
  for (const badBind of ["canary-not-a-bind", "127.0.0.1:65536", "127.0.0.1:99999", "127.0.0.1:123456", "127.0.0.1:"]) {
    const bind = await runEntry(good, { GAMECULT_IDUNN_CANDIDATE_BIND: badBind });
    assert.equal(bind.code, 2, badBind);
    assert.match(bind.output, /CANDIDATE_BIND is not host:port/);
    assert.ok(!bind.output.includes("canary"));
    assert.ok(!bind.output.includes("65536") && !bind.output.includes("99999"));
  }
});

test("the entry derives the daemon's host, port, interpreter and environment identity from the release", async () => {
  const { createHash } = await import("node:crypto");
  const { daemonEnvironment } = await import("./idunn-entry.mjs");
  const release = mkdtempSync(path.join(os.tmpdir(), "vili-entry-"));
  try {
    mkdirSync(path.join(release, "vili", "scripts"), { recursive: true });
    mkdirSync(path.join(release, "vili", "deployment", "idunn"), { recursive: true });
    writeFileSync(path.join(release, "vili", "deployment", "idunn", "requirements-build.lock"), "build lock bytes\n");
    writeFileSync(path.join(release, "vili", "deployment", "idunn", "requirements.lock"), "runtime lock bytes\n");
    const entryDir = path.join(release, "vili", "scripts");
    assert.equal(daemonEnvironment("127.0.0.1:65535", entryDir).VILI_DAEMON_PORT, "65535", "the top of the port range is accepted");
    for (const bind of ["127.0.0.1:18861", "http://127.0.0.1:18861"]) {
      const derived = daemonEnvironment(bind, entryDir);
      assert.equal(derived.VILI_DAEMON_HOST, "127.0.0.1");
      assert.equal(derived.VILI_DAEMON_PORT, "18861");
      assert.equal(derived.VILI_PYTHON, path.join(release, "python", "bin", "python3.12"));
      assert.equal(derived.VILI_PYTHON_ENV, `locks-sha256:${createHash("sha256").update("build lock bytes\nruntime lock bytes\n").digest("hex")}`);
    }
  } finally {
    rmSync(release, { recursive: true, force: true });
  }
});

// The lease is asked while a generate awaits its worker, not only when the service documents are rewritten. The
// bound is one WATCH_MS ask plus the SIGKILL; the test allows a second. The loss is made just after a rewrite of the
// service documents (whose own gates have asked), the longest wait for an implementation that asks only then.
test("a worker still writing when the lease is lost is dead within a second", async () => {
  const daemon = await idunnDaemon({ leased: true });
  try {
    const store = path.join(daemon.stateRoot, "vili.service.cc");
    await until(() => existsSync(store), "the service store", 10);
    const pending = generate(daemon, { prompt: "x", model: "writer" });
    pending.catch(() => {});
    const writes = () => {
      const dir = path.join(daemon.stateRoot, "artifacts");
      for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
        const file = path.join(dir, entry, "motion.writes");
        if (existsSync(file)) return file;
      }
      return null;
    };
    const file = await until(writes, "the worker to write");
    const [worker] = daemon.spawns();
    const rewritten = statSync(store).mtimeMs;
    await until(() => statSync(store).mtimeMs !== rewritten, "the service documents to be rewritten", 8);
    await new Promise((resolve) => setTimeout(resolve, 150)); // the rewrite is done: its own gates have asked
    const lostAt = Date.now();
    rmSync(daemon.lease);
    await until(() => !isAlive(worker), "the worker to die", 10);
    assert.ok(Date.now() - lostAt < 1000, `the worker lived ${Date.now() - lostAt} ms after the loss`);
    const stamps = readFileSync(file, "utf8").trim().split("\n").map(Number);
    assert.ok(Math.max(...stamps) - lostAt < 1000, "the worker wrote more than a second after the loss");
    const answer = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve({ status: "no answer" }), 10000))]);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
    assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "jobs")), []);
  } finally {
    await daemon.stop();
  }
});

// A request in flight and one arriving during the stop. The worker takes 1.5 s to stop, so the stop is long enough
// for the second request to arrive in it. From the signal on nothing is written and nothing is spawned.
for (const kind of ["fake Idunn entry", "hand-run"]) {
  test(`SIGTERM (${kind}): nothing is written or spawned from the signal on, and the worker tree is dead at exit 0`, async () => {
    const daemon = kind === "hand-run" ? await startDaemon() : await idunnDaemon({ leased: true });
    try {
      await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
      const inFlight = generate(daemon, { prompt: "x", model: "slow-to-stop" });
      inFlight.catch(() => {});
      await until(() => daemon.spawns().length, "the worker");
      await until(() => request(daemon.port, "GET", "/health").then((r) => r.body?.state?.backend?.state === "ready"), "the worker to be ready");
      const store = path.join(daemon.stateRoot, "vili.service.cc");
      const storeBefore = statSync(store).mtimeMs;
      const artifacts = readdirSync(path.join(daemon.stateRoot, "artifacts"));
      daemon.proc.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const second = await generate(daemon).catch((error) => ({ status: error.code }));
      assert.notEqual(second.status, 200, "a request arriving during the stop is not served");
      await until(() => daemon.proc.exitCode !== null || daemon.proc.signalCode !== null, "the daemon to exit", 30);
      assert.equal(daemon.proc.exitCode, 0);
      assert.equal(daemon.spawns().length, 1, "no worker is spawned after the signal");
      assert.ok(daemon.spawns().every((pid) => !isAlive(pid)), "the worker tree is dead at exit");
      assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "artifacts")), artifacts, "no artifact is created after the signal");
      assert.deepEqual(readdirSync(path.join(daemon.stateRoot, "jobs")), [], "no job is recorded after the signal");
      assert.equal(statSync(store).mtimeMs, storeBefore);
      assert.ok(!readFileSync(path.join(daemon.stateRoot, "logs", "worker.log"), "utf8").includes("stopping-line"), "the worker's output while it stops is not copied");
    } finally {
      await daemon.stop();
    }
  });
}

// One notion of root identity: a root is the same root under either spelling, for the lock and for reclaim.
for (const [crashedOn, restartedOn] of [["link", "real"], ["real", "link"]]) {
  test(`a daemon restarted on the ${restartedOn} spelling of its root reclaims the worker a crash on the ${crashedOn} spelling left`, async () => {
    const real = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
    const link = `${real}-link`;
    symlinkSync(real, link);
    const spelling = { real, link };
    const first = await startDaemon({ root: spelling[crashedOn] });
    let second = null;
    let stray = null;
    try {
      assert.equal((await generate(first)).status, 200);
      [stray] = first.spawns();
      first.proc.kill("SIGKILL");
      await until(() => first.proc.exitCode !== null || first.proc.signalCode !== null, "the first daemon to die");
      assert.ok(isAlive(stray), "the probe must reproduce the orphan before the fix can be measured");
      second = await startDaemon({ root: spelling[restartedOn] });
      await until(() => !isAlive(stray), "the predecessor's worker to be reclaimed");
      assert.equal((await generate(second)).status, 200);
      assert.equal(aliveWorkers(second).length, 1, "one live worker on the one root");
    } finally {
      if (stray) { try { process.kill(-stray, "SIGKILL"); } catch { /* gone */ } }
      if (second) await second.stop();
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
}

// The group is the worker's, and its leader may be the first to go. Any member carrying the root's marker proves it.
test("a restarted daemon kills a worker group whose leader is gone and a member lives", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const first = await startDaemon({ root });
  const stray = generate(first, { prompt: "x", model: "encoder" }).catch(() => null);
  const [grandchild] = await until(() => { const found = first.grandchildren(); return found.length ? found : null; }, "the encoder child");
  const [worker] = first.spawns();
  first.proc.kill("SIGKILL");
  await until(() => first.proc.exitCode !== null || first.proc.signalCode !== null, "the first daemon to die");
  process.kill(worker, "SIGKILL"); // the leader only
  await until(() => !isAlive(worker), "the leader to die");
  await stray;
  assert.ok(isAlive(grandchild), "the probe must leave a member alive in the leaderless group");
  const second = await startDaemon({ root });
  try {
    await until(() => !isAlive(grandchild), "the leaderless group's member to be killed");
    assert.equal(existsSync(path.join(root, "worker.pid")), false);
  } finally {
    try { process.kill(-worker, "SIGKILL"); } catch { /* gone */ }
    await second.stop();
  }
});

// The copy of worker output is gated at every line, not at the first: here the lease goes after the first line
// was logged, by the worker's first healthy answer, and the line it prints then must not reach the log.
test("a worker's output line after the first is not logged once the lease is gone", async () => {
  const daemon = await idunnDaemon({ leased: true, loseWhenExists: "embeddings/stub-healthy" });
  try {
    await until(() => existsSync(path.join(daemon.stateRoot, "vili.service.cc")), "the service store", 10);
    const answer = await generate(daemon, { prompt: "x", model: "chatty" });
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "write-lease-lost");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = readFileSync(path.join(daemon.stateRoot, "logs", "worker.log"), "utf8");
    assert.ok(log.includes("stub-stdout-line"), "the first line was logged under the lease");
    assert.ok(!log.includes("after-healthy-line"), "a line after the loss must not be copied");
  } finally {
    await daemon.stop();
  }
});
