// Stands in for kimodo-resident-worker.py in the daemon's tests. It binds port 0, prints the ready line the
// daemon waits for, and answers /health and /generate with what the daemon gave it. The --model value picks a
// misbehaviour: crash-before-ready, hang-before-ready, sick, slow-health, stubborn, fail-generate,
// refuse-generate, drop-generate, slow-generate, writer (appends to <output>.writes every 50 ms and never answers), slow-to-stop (no answer; exits 1.5 s after SIGTERM), chatty (prints a line the moment it is healthy), encoder (a grandchild, then no answer), graceful (exits 0.5 s after SIGTERM), die-after-ready. Any other value is just the model the worker serves.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const model = flag("--model");
const spawnLog = path.join(process.env.VILI_EMBEDDINGS_DIR, "stub-spawns.log");
let requests = 0;
let healthCalls = 0;

appendFileSync(spawnLog, `${process.pid}\n`);
console.log("stub-stdout-line");
console.error("stub-stderr-line");
// decoys: neither is the ready line
console.log(JSON.stringify({ event: "progress", port: 1 }));
console.log(JSON.stringify({ event: "kimodo-worker-ready", port: "not-a-port" }));

if (model === "crash-before-ready") process.exit(3);

if (model === "stubborn") {
  process.on("SIGTERM", () => {});
  // the grandchild reports itself once its handler is armed, so a test never reads a pid that would die of the default SIGTERM
  spawn(process.execPath, ["-e", `process.on('SIGTERM', () => {}); require('fs').appendFileSync(${JSON.stringify(spawnLog)}, 'grandchild ' + process.pid + '\\n'); setInterval(() => {}, 1000)`], { stdio: "ignore" });
}

if (model === "slow-to-stop") process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1500));

if (model === "graceful") {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      appendFileSync(spawnLog, "graceful-exit\n");
      process.exit(0);
    }, 500);
  });
}

if (model === "hang-before-ready") {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && request.url === "/health") {
        healthCalls += 1;
        if (model === "sick" || model === "die-after-ready" || (model === "slow-health" && healthCalls <= 2)) return send(200, { ok: false });
        writeFileSync(path.join(process.env.VILI_EMBEDDINGS_DIR, "stub-healthy"), ""); // a test can act the moment the worker is healthy
        if (model === "chatty") console.log("after-healthy-line"); // after stub-healthy exists, which a test can make the loss of the lease
        send(200, { ok: true, model: model || "stub-model", displayModel: model || "Stub Model", pid: process.pid, requests });
      } else if (request.method === "POST" && request.url === "/generate") {
        requests += 1;
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (model === "fail-generate") return send(500, { ok: false });
        if (model === "refuse-generate") return send(200, { ok: false });
        if (model === "drop-generate") return request.socket.destroy();
        if (model === "slow-generate" || model === "slow-to-stop") return;
        if (model === "writer") {
          setInterval(() => appendFileSync(`${payload.output}.writes`, `${Date.now()}\n`), 50);
          return;
        }
        if (model === "encoder") {
          // an encoder child of the real worker: a grandchild in the worker's group, then a request that never answers
          spawn(process.execPath, ["-e", `process.on('SIGTERM', () => {}); require('fs').appendFileSync(${JSON.stringify(spawnLog)}, 'grandchild ' + process.pid + '\\n'); setInterval(() => {}, 1000)`], { stdio: "ignore" });
          return;
        }
        send(200, {
          ok: true,
          model: model || "stub-model",
          pid: process.pid,
          requests,
          contentType: request.headers["content-type"],
          output: payload.output,
          prompt: payload.prompt,
          constraints: payload.constraints,
          priority: os.getPriority(),
          env: {
            OMP_NUM_THREADS: process.env.OMP_NUM_THREADS,
            MKL_NUM_THREADS: process.env.MKL_NUM_THREADS,
            VILI_THREADS: process.env.VILI_THREADS,
            HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE,
            TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE,
            HF_HOME: process.env.HF_HOME,
            PYTHONPATH: process.env.PYTHONPATH,
            PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE,
            PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED,
            VILI_KIMODO_COMMIT: process.env.VILI_KIMODO_COMMIT,
            VILI_PYTHON_ENV: process.env.VILI_PYTHON_ENV,
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            LEAK_CHECK: process.env.LEAK_CHECK,
          },
          argv,
        });
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });

  server.listen(Number(flag("--port")), flag("--host"), () => {
    console.log(JSON.stringify({ event: "kimodo-worker-ready", port: server.address().port }));
    if (model === "die-after-ready") setTimeout(() => process.exit(4), 300);
  });
}
