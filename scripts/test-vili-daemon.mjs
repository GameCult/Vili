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

async function until(condition, what) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await condition();
    if (value) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startDaemon({ configured = true } = {}) {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "vili-test-"));
  const modelsRoot = path.join(stateRoot, "models");
  const argv = [
    daemonPath, "--port", "0", "--state-root", stateRoot, "--python", process.execPath, "--worker-entry", stubPath,
    "--threads", String(THREADS), "--python-env", "test-env",
  ];
  if (configured) argv.push("--models-root", modelsRoot, "--kimodo-commit", "abc1234");
  const proc = spawn(process.execPath, argv, { env: { ...process.env, LEAK_CHECK: "leaked" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  const port = await until(() => /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1], "the daemon to listen");
  return {
    stateRoot,
    modelsRoot,
    proc,
    port: Number(port),
    spawns: () => {
      const log = path.join(stateRoot, "embeddings", "stub-spawns.log");
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number) : [];
    },
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await until(() => proc.exitCode !== null || proc.signalCode !== null, "the daemon to exit");
      }
      rmSync(stateRoot, { recursive: true, force: true });
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

test("the worker's port comes from its ready line", async () => {
  const daemon = await startDaemon();
  try {
    const answer = await generate(daemon);
    assert.equal(answer.status, 200);
    const backend = (await operatorState(daemon)).backend;
    assert.equal(backend.state, "ready");
    assert.ok(Number.isInteger(backend.port) && backend.port > 0 && backend.port !== 8825);
    assert.equal(answer.body.worker.pid, backend.pid);
    assert.deepEqual(answer.body.worker.argv.slice(-4), ["--host", "127.0.0.1", "--port", "0"]);
    // the request reached the stub on the port the stub printed
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
    await until(async () => (await operatorState(daemon)).backend.state === "stopped", "the daemon to see the exit");
    const third = await generate(daemon);
    assert.equal(third.status, 200);
    const spawns = daemon.spawns();
    assert.equal(spawns.length, 2);
    assert.notEqual(spawns[1], pid);
    assert.equal(third.body.worker.pid, spawns[1]);
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
    assert.ok(env.PYTHONPATH.endsWith(path.join("vendor", "CultLib", "packages", "cultcache-py", "src")));
    assert.equal(env.LEAK_CHECK, undefined, "the daemon's own environment does not reach the worker");
    assert.equal(priority, 10);
  } finally {
    await daemon.stop();
  }
});

test("SIGTERM leaves no child", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await generate(daemon)).status, 200);
    const [pid] = daemon.spawns();
    process.kill(pid, 0);
    daemon.proc.kill("SIGTERM");
    await until(() => daemon.proc.exitCode !== null, "the daemon to exit");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
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
    assert.equal(withOrigin.body.code, "cross-site");
    const plain = await generate(daemon, undefined, { "content-type": "text/plain" });
    assert.equal(plain.status, 403);
    assert.equal(plain.body.code, "cross-site");
    const options = await request(daemon.port, "OPTIONS", "/motion/generate", { headers: { origin: "https://example.test" } });
    assert.equal(options.status, 404);
    const health = await request(daemon.port, "GET", "/health");
    for (const reply of [withOrigin, plain, options, health]) {
      assert.equal(Object.keys(reply.headers).filter((name) => name.startsWith("access-control-")).length, 0);
    }
    const backend = (await operatorState(daemon)).backend;
    assert.equal((await request(backend.port, "GET", "/health")).body.requests, 1, "only the same-site request reached the worker");
  } finally {
    await daemon.stop();
  }
});

test("unconfigured refuses before spawning", async () => {
  const daemon = await startDaemon({ configured: false });
  try {
    const answer = await generate(daemon);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, "worker-unconfigured");
    assert.deepEqual(daemon.spawns(), []);
    assert.equal((await operatorState(daemon)).backend.state, "stopped");
  } finally {
    await daemon.stop();
  }
});

test("an error never echoes the request", async () => {
  const daemon = await startDaemon();
  try {
    const malformed = await generate(daemon, "{\"prompt\": \"the launch code is swordfish\", ");
    assert.equal(malformed.status, 400);
    assert.ok(!malformed.raw.includes("swordfish"));
    const missing = await generate(daemon, { texts: ["the launch code is swordfish"] });
    assert.equal(missing.status, 400);
    assert.ok(!missing.raw.includes("swordfish"));
  } finally {
    await daemon.stop();
  }
});

test("a thread count outside 1 to 16 stops the daemon without echoing it", async () => {
  for (const threads of ["0", "17", "99", "8x"]) {
    const proc = spawn(process.execPath, [daemonPath, "--threads", threads], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout.on("data", (chunk) => { output += chunk; });
    proc.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => proc.on("exit", resolve));
    assert.equal(code, 2);
    assert.ok(!output.includes(threads), `the refusal repeated ${threads}`);
  }
});
