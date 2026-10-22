// Boots the real daemon and observes the gate where it is decided: the HTTP edge. Needs the
// daemon's own dependencies (ws, cultcache-ts), so it runs on a machine that has them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "vili-daemon.mjs");
const port = 18000 + Math.floor(Math.random() * 1000);

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
