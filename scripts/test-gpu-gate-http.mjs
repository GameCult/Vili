// Boots the real daemon and observes the gate where it is decided: the HTTP edge. Needs the
// daemon's own dependencies (ws, cultcache-ts), so it runs on a machine that has them. Every boot
// sets VILI_GPU_MIN_FREE_MIB=999999 so an allowed request ends in a VRAM refusal and never starts
// the worker: no test here may start a GPU job.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "vili-daemon.mjs");
let nextPort = 18000 + Math.floor(Math.random() * 1000);

async function bootDaemon(stateRoot, { host = "127.0.0.1", env = { VILI_GPU_MIN_FREE_MIB: "999999" } } = {}) {
  const port = nextPort++;
  const child = spawn(process.execPath, [daemonPath, "--host", host, "--port", String(port), "--state-root", stateRoot], {
    env: { ...process.env, ...env },
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
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else { child.once("exit", resolve); child.kill(); }
  });
  return { child, port, stop };
}

const url = (d, route, host = "127.0.0.1") => `http://${host}:${d.port}${route}`;
const generate = (d, body) => fetch(url(d, "/motion/generate"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const setPermission = (d, body, host = "127.0.0.1") => fetch(url(d, "/gpu-permission", host), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const readPermission = async (d) => (await fetch(url(d, "/gpu-permission"))).json();

test("http: refusal at the daemon edge", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-"));
  const d = await bootDaemon(stateRoot);
  try {
    assert.deepEqual(await readPermission(d), { allowed: false, changedAt: null, jobRunning: false, lastRefusal: null });
    assert.equal((await generate(d, {})).status, 400, "request-shape errors come ahead of the gate");

    const refused = await generate(d, { prompt: "a person waves hello, never seen before" });
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "60");
    assert.deepEqual(await refused.json(), { ok: false, code: "gpu-busy", source: "household", gpu: { allowed: false, changedAt: null } });

    assert.deepEqual(await readdir(path.join(stateRoot, "jobs")), [], "no job file");
    assert.equal((await readdir(stateRoot)).includes("artifacts"), false, "no artifact directory");

    const state = await (await fetch(url(d, "/operator-state"))).json();
    assert.equal(state.gpu.lastRefusal.source, "household");
    assert.equal(state.gpu.allowed, false);
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: the permission persists across a daemon restart", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-persist-"));
  let d = await bootDaemon(stateRoot);
  try {
    const on = await setPermission(d, { allowed: true });
    assert.equal(on.status, 200);
    const onBody = await on.json();
    assert.equal(onBody.ok, true);
    assert.equal(onBody.gpu.allowed, true);
    const before = await readPermission(d);
    assert.equal(before.allowed, true);
    assert.ok(before.changedAt);

    assert.equal((await setPermission(d, { allowed: "yes" })).status, 400);
    assert.equal((await setPermission(d, {})).status, 400);
    assert.deepEqual(await readPermission(d), before, "a refused write changes nothing");

    await d.stop();
    d = await bootDaemon(stateRoot);
    const after = await readPermission(d);
    assert.equal(after.allowed, true);
    assert.equal(after.changedAt, before.changedAt);

    await setPermission(d, { allowed: false });
    await d.stop();
    d = await bootDaemon(stateRoot);
    assert.equal((await readPermission(d)).allowed, false, "off persists too");
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: an allowed request reaches the slot and the VRAM read", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-slot-"));
  const d = await bootDaemon(stateRoot);
  try {
    await setPermission(d, { allowed: true });
    const refused = await generate(d, { prompt: "a person waves hello, never seen before" });
    assert.equal(refused.status, 503);
    const body = await refused.json();
    assert.equal(body.source, "vram", "admitted through acquire(), then refused for VRAM");
    assert.equal(body.minFreeMiB, 999999);
    assert.deepEqual(await readdir(path.join(stateRoot, "jobs")), [], "no job file");
    assert.equal((await readdir(stateRoot)).includes("artifacts"), false);
    const state = await readPermission(d);
    assert.equal(state.lastRefusal.source, "vram");
    assert.equal(state.jobRunning, false);
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: the switch is the household's", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-lan-"));
  const d = await bootDaemon(stateRoot, { host: "0.0.0.0" });
  try {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address;
    assert.ok(lan, "the host has a non-loopback IPv4 address");
    const before = await readPermission(d);
    const refused = await setPermission(d, { allowed: true }, lan);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { ok: false, code: "household-only" });
    assert.deepEqual(await readPermission(d), before, "GET still reads the previous value");
    assert.equal((await setPermission(d, { allowed: true })).status, 200, "loopback still sets it");
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: a web page cannot flip the household's switch or start a job", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-csrf-"));
  const d = await bootDaemon(stateRoot);
  const post = (route, headers, body) => fetch(url(d, route), { method: "POST", headers, body });
  const prompt = JSON.stringify({ prompt: "a person waves hello, never seen before" });
  try {
    const before = await readPermission(d);
    for (const route of ["/gpu-permission", "/motion/generate"]) {
      const payload = route === "/gpu-permission" ? JSON.stringify({ allowed: true }) : prompt;
      const simple = await post(route, { "content-type": "text/plain" }, payload);
      assert.equal(simple.status, 403, `${route}: a simple text/plain POST`);
      assert.deepEqual(await simple.json(), { ok: false, code: "cross-site" });
      assert.equal((await post(route, {}, payload)).status, 403, `${route}: no content-type`);
      const hostile = await post(route, { "content-type": "application/json", origin: "http://evil.example-origin" }, payload);
      assert.equal(hostile.status, 403, `${route}: a hostile Origin`);
      const body = JSON.stringify(await hostile.json());
      assert.equal(body.includes("evil.example-origin"), false, "the refusal never echoes the Origin");
      assert.equal(
        (await post(route, { "content-type": "application/json", origin: `http://127.0.0.1:${d.port}.evil.example` }, payload)).status,
        403,
        `${route}: an Origin that only starts like ours`,
      );
    }
    assert.deepEqual(await readPermission(d), before, "no refused request changed anything");
    assert.deepEqual(await readdir(path.join(stateRoot, "jobs")), [], "no job file");

    const preflight = await fetch(url(d, "/gpu-permission"), {
      method: "OPTIONS",
      headers: { origin: "http://evil.example-origin", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.equal(preflight.ok, false, "the daemon approves no CORS preflight");
    assert.equal(preflight.headers.get("access-control-allow-methods"), null);

    const own = await post("/gpu-permission", { "content-type": "application/json; charset=utf-8", origin: `http://127.0.0.1:${d.port}` }, JSON.stringify({ allowed: true }));
    assert.equal(own.status, 200, "the daemon's own origin still works");
    assert.equal((await setPermission(d, { allowed: false })).status, 200, "a caller with no Origin (the tray) still works");
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: a malformed override refuses to start and names the variable, not its value", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-env-"));
  const child = spawn(process.execPath, [daemonPath, "--host", "127.0.0.1", "--port", String(nextPort++), "--state-root", stateRoot], {
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
