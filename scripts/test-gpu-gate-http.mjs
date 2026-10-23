// Boots the real daemon and observes the gate where it is decided: the HTTP edge. Needs the
// daemon's own dependencies (ws, cultcache-ts), so it runs on a machine that has them. Every boot
// sets VILI_GPU_MIN_FREE_MIB=999999 so an allowed request ends in a VRAM refusal and never starts
// the worker: no test here may start a GPU job.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  const addresses = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
  const lan = addresses[0];
  assert.ok(lan, "the host has a non-loopback IPv4 address");
  const d = await bootDaemon(stateRoot, { host: `127.0.0.1,${lan}` });
  try {
    const before = await readPermission(d);
    const refused = await setPermission(d, { allowed: true }, lan);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { ok: false, code: "household-only" });
    assert.deepEqual(await readPermission(d), before, "GET still reads the previous value");
    assert.equal((await setPermission(d, { allowed: true })).status, 200, "loopback still sets it");
    const other = addresses.find((address) => address !== lan);
    if (other) {
      await assert.rejects(fetch(url(d, "/gpu-permission", other)), "an address --host does not name is not served");
    }
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

// The daemon reaches the GPU only through the processes wsl.exe and nvidia-smi.exe. This test puts
// one small compiled stub on PATH under both names (Windows, where the daemon lives), so the real
// daemon runs a real job against a worker that takes as long as the test says and touches no GPU:
// nvidia-smi.exe answers 20000 free MiB, the worker health call answers ok, and the "/generate"
// call waits until the test creates a release file.
const stubSource = `
using System; using System.IO; using System.Reflection; using System.Threading;
class Stub {
  static int Main(string[] args) {
    string exe = Path.GetFileNameWithoutExtension(Assembly.GetEntryAssembly().Location).ToLowerInvariant();
    string dir = Environment.GetEnvironmentVariable("VILI_STUB_DIR");
    if (exe == "nvidia-smi") { Console.WriteLine("20000"); return 0; }
    string script = args.Length > 0 ? args[args.Length - 1] : "";
    if (script.Contains("docker run")) File.AppendAllText(Path.Combine(dir, "dockerrun"), "x");
    if (script.Contains("service docker start")) File.AppendAllText(Path.Combine(dir, "dockerstart"), "x");
    if (script.Contains("/health")) { Console.WriteLine("{\\"ok\\":true,\\"model\\":\\"stub\\"}"); return 0; }
    if (script.Contains("/generate")) {
      File.AppendAllText(Path.Combine(dir, "started"), "x");
      while (!File.Exists(Path.Combine(dir, "release"))) Thread.Sleep(25);
      Console.WriteLine("{\\"ok\\":true}");
    }
    return 0;
  }
}`;

async function stubbedDaemon(stubDir, stateRoot) {
  const source = path.join(stubDir, "stub.cs");
  await writeFile(source, stubSource);
  const build = path.join(stubDir, "build.ps1");
  await writeFile(build, [
    "param($Source, $Out)",
    "Add-Type -TypeDefinition (Get-Content -Raw $Source) -OutputAssembly $Out -OutputType ConsoleApplication",
  ].join("\r\n"));
  const built = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", build, source, path.join(stubDir, "wsl.exe"),
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(built.status, 0, `the stub did not compile: ${built.stderr || built.stdout}`);
  await copyFile(path.join(stubDir, "wsl.exe"), path.join(stubDir, "nvidia-smi.exe"));
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  return bootDaemon(stateRoot, {
    env: {
      [pathKey]: `${stubDir}${path.delimiter}${process.env[pathKey]}`,
      VILI_STUB_DIR: stubDir,
      VILI_GPU_MIN_FREE_MIB: "1",
    },
  });
}

test("http: the daemon holds the slot for the whole job", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-hold-"));
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "vili-gate-stub-"));
  const d = await stubbedDaemon(stubDir, stateRoot);
  const prompt = { prompt: "a person waves hello, never seen before" };
  const within = (promise, ms, what) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)),
  ]);
  try {
    await setPermission(d, { allowed: true });
    const first = generate(d, prompt);
    const deadline = Date.now() + 20000;
    while (!(await readPermission(d)).jobRunning) {
      assert.ok(Date.now() < deadline, "the first job never took the slot");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (!existsSync(path.join(stubDir, "started"))) {
      assert.ok(Date.now() < deadline, "the first job never reached the worker");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    for (let i = 0; i < 3; i += 1) {
      const second = await within(generate(d, prompt), 5000, "a request during the job");
      assert.equal(second.status, 503, "a request during the job is refused at once");
      assert.deepEqual(await second.json(), { ok: false, code: "gpu-busy", source: "slot" });
    }
    assert.equal(readFileSync(path.join(stubDir, "started"), "utf8"), "x", "exactly one job reached the worker");
    assert.equal((await readPermission(d)).jobRunning, true, "the slot is still held");

    await writeFile(path.join(stubDir, "release"), "");
    const done = await within(first, 20000, "the first job");
    assert.equal(done.status, 200);
    assert.equal((await readPermission(d)).jobRunning, false, "the slot frees when the job ends");
    const next = await within(generate(d, prompt), 20000, "the next job");
    assert.equal(next.status, 200, "the next job is admitted after the slot frees");
    assert.equal(readFileSync(path.join(stubDir, "started"), "utf8"), "xx");
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
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

test("http: the daemon refuses to listen on a wildcard address", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-wild-"));
  try {
    for (const host of ["0.0.0.0", "127.0.0.1,0.0.0.0", "::"]) {
      const run = spawnSync(process.execPath, [daemonPath, "--host", host, "--port", String(nextPort++), "--state-root", stateRoot], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
      });
      assert.equal(run.status, 2, `--host ${host} exits 2`);
      assert.equal(`${run.stdout}${run.stderr}`.includes("Vili listening"), false);
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: no response grants a web page access", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-cors-"));
  const d = await bootDaemon(stateRoot);
  try {
    const hostile = { origin: "http://evil.example-origin" };
    const responses = [
      await fetch(url(d, "/gpu-permission"), { headers: hostile }),
      await fetch(url(d, "/operator-state"), { headers: hostile }),
      await fetch(url(d, "/nowhere"), { headers: hostile }),
      await fetch(url(d, "/gpu-permission"), { method: "POST", headers: { ...hostile, "content-type": "application/json" }, body: "{}" }),
    ];
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 404, 403]);
    for (const response of responses) {
      const cors = [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
      assert.deepEqual(cors, [], "no access-control header on any response");
    }
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("http: with the permission off nothing a web page or a LAN caller sends reaches the GPU", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-off-"));
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "vili-gate-stub-"));
  const d = await stubbedDaemon(stubDir, stateRoot);
  const page = { origin: "http://evil.example-origin", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };
  try {
    const before = await readPermission(d);
    assert.equal(before.allowed, false);
    for (const route of ["/smoke", "/health", "/", "/operator-state", "/eve/operator", "/provider-advertisement", "/eve/deck/providers", "/gpu-permission"]) {
      const response = await fetch(url(d, route), { headers: page });
      assert.equal(response.status, route === "/smoke" ? 404 : 200, `GET ${route}`);
    }
    const refused = await generate(d, { prompt: "a person waves hello, never seen before" });
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).source, "household");
    assert.equal((await setPermission(d, { allowed: true }, "127.0.0.1")).status, 200);
    assert.equal((await setPermission(d, { allowed: false }, "127.0.0.1")).status, 200);
    assert.deepEqual((await readPermission(d)).allowed, false);
    assert.equal(existsSync(path.join(stubDir, "dockerrun")), false, "nothing ran docker run (the worker or any GPU container)");
    assert.equal(existsSync(path.join(stubDir, "dockerstart")), false, "no GET started Docker");
    assert.equal(existsSync(path.join(stubDir, "started")), false, "nothing reached the worker");
    assert.deepEqual(await readdir(path.join(stateRoot, "jobs")), [], "no job file");
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
});

test("http: a client that hangs up mid-job does not free the slot", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "vili-gate-hangup-"));
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "vili-gate-stub-"));
  const d = await stubbedDaemon(stubDir, stateRoot);
  const prompt = { prompt: "a person waves hello, never seen before" };
  const hangUp = new AbortController();
  try {
    await setPermission(d, { allowed: true });
    const first = fetch(url(d, "/motion/generate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prompt),
      signal: hangUp.signal,
    }).catch((error) => error);
    const deadline = Date.now() + 20000;
    while (!existsSync(path.join(stubDir, "started"))) {
      assert.ok(Date.now() < deadline, "the job never reached the worker");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    hangUp.abort();
    assert.equal((await first).name, "AbortError", "the client hung up");
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.equal((await readPermission(d)).jobRunning, true, "the slot is still held after the hang-up");
    const second = await generate(d, prompt);
    assert.equal(second.status, 503);
    assert.equal((await second.json()).source, "slot");
    assert.equal(readFileSync(path.join(stubDir, "started"), "utf8"), "x", "no second job reached the worker");

    await writeFile(path.join(stubDir, "release"), "");
    const freed = Date.now() + 20000;
    while ((await readPermission(d)).jobRunning) {
      assert.ok(Date.now() < freed, "the slot never freed when the job ended");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await d.stop();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
});
