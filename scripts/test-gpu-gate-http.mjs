// Boots the real daemon and observes the gate where it is decided: the HTTP edge. A fresh daemon is
// in use until a clear hold passes, so a new job is refused whatever the host is doing. Needs the
// daemon's own dependencies (ws, cultcache-ts), so it runs on a machine that has them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "vili-daemon.mjs");
const port = 18000 + Math.floor(Math.random() * 1000);

async function bootDaemon(stateRoot) {
  const child = spawn(process.execPath, [daemonPath, "--host", "127.0.0.1", "--port", String(port), "--state-root", stateRoot], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 30000;
  while (!output.includes("Vili listening")) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`daemon did not start: ${output.slice(-500)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return child;
}

const post = (body) => fetch(`http://127.0.0.1:${port}/motion/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("a new job is refused 503 gpu-busy with retry-after, creating nothing; validation stays 400", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-"));
  const daemon = await bootDaemon(stateRoot);
  try {
    const invalid = await post({});
    assert.equal(invalid.status, 400, "request-shape errors come ahead of the gate");

    const refused = await post({ prompt: "a person waves hello, never seen before" });
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "60");
    const body = await refused.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "gpu-busy");
    assert.equal(body.source, "admission");
    assert.equal(body.gpu.inUse, true);
    assert.deepEqual(Object.keys(body.gpu).sort(), ["checkedAt", "inUse", "probeOk", "since"]);
    assert.equal(body.jobId, undefined);

    assert.deepEqual(await readdir(path.join(stateRoot, "jobs")), [], "no job file");
    assert.equal((await readdir(stateRoot)).includes("artifacts"), false, "no artifact directory");

    const state = await (await fetch(`http://127.0.0.1:${port}/operator-state`)).json();
    assert.deepEqual(Object.keys(state.gpu).sort(), ["checkedAt", "inUse", "probeOk", "since"]);
    assert.equal(state.gpu.inUse, true);
  } finally {
    daemon.kill();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a malformed GPU override refuses to start and names the variable, not its value", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-env-"));
  const child = spawn(process.execPath, [daemonPath, "--host", "127.0.0.1", "--port", String(port + 1), "--state-root", stateRoot], {
    env: { ...process.env, VILI_GPU_MIN_FREE_MIB: "10240MiB-secret" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.notEqual(code, 0);
    assert.match(output, /VILI_GPU_MIN_FREE_MIB must be a finite non-negative number/);
    assert.equal(output.includes("10240MiB-secret"), false);
    assert.equal(output.includes("Vili listening"), false);
  } finally {
    child.kill();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
