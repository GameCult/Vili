// Stands in for kimodo-resident-worker.py in the daemon's tests. It binds port 0, prints the ready line the
// daemon waits for, and answers /health and /generate with what the daemon gave it. The --model value picks a
// misbehaviour: crash-before-ready, hang-before-ready, sick, slow-health, stubborn, fail-generate,
// refuse-generate, drop-generate, slow-generate, writer (appends to <output>.writes every 50 ms, never answers, ignores SIGTERM), slow-to-stop (no answer; prints a line and exits 1.5 s after SIGTERM), chatty (prints a line the moment it is healthy), encoder (a grandchild, then no answer), graceful (exits 0.5 s after SIGTERM), die-after-ready, bvh-outside (lists a BVH outside the job's directory), bvh-link (lists a symlink as its BVH), bvh-fifo (lists a FIFO as its BVH), plant-link (a normal answer with a file symlink and a directory symlink planted beside the BVH), no-loops (a normal answer that leaves out the loops a loop request asked for), bad-loops, negative-loops, empty-loops, fractional-last-loops (loops whose window is not a frame range: a fractional first, a negative first, first equal to last, a fractional last), short-loops (one window fewer than samples). A loop request is answered with loops, sample k as {first 3 + k, last 223 + k}. A request with bvh writes <output>.bvh (motion/motion_NN.bvh for several samples) and lists it. Any other value is just the model the worker serves.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const model = flag("--model");
const BAD_WINDOWS = {
  "bad-loops": { first: 5.5, last: 9 },
  "negative-loops": { first: -1, last: 9 },
  "empty-loops": { first: 7, last: 7 },
  "fractional-last-loops": { first: 5, last: 9.5 },
};
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

if (model === "slow-to-stop") process.on("SIGTERM", () => {
  console.log("stopping-line"); // output while it stops
  setTimeout(() => process.exit(0), 1500);
});
if (model === "writer") process.on("SIGTERM", () => {}); // a worker that carries on writing through SIGTERM

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
        let files;
        if (payload.bvh) {
          const outside = path.join(path.dirname(payload.output), "..", "outside.bvh");
          if (model === "bvh-outside") {
            writeFileSync(outside, "BVH-OUTSIDE\n");
            files = [outside];
          } else if (model === "bvh-fifo") {
            execFileSync("mkfifo", [`${payload.output}.bvh`]);
            files = [`${payload.output}.bvh`];
          } else if (model === "bvh-link") {
            writeFileSync(outside, "BVH-OUTSIDE\n");
            symlinkSync(outside, `${payload.output}.bvh`);
            files = [`${payload.output}.bvh`];
          } else if (payload.numSamples > 1) {
            mkdirSync(payload.output, { recursive: true });
            files = Array.from({ length: payload.numSamples }, (_, index) => path.join(payload.output, `motion_${String(index).padStart(2, "0")}.bvh`));
            for (const [index, file] of files.entries()) writeFileSync(file, `BVH-STUB sample ${index}\n`);
            files.reverse(); // the worker's listing order is not the daemon's clip order
          } else {
            writeFileSync(`${payload.output}.npz`, "NPZ-STUB\n");
            writeFileSync(`${payload.output}.bvh`, "BVH-STUB\n");
            files = [`${payload.output}.npz`, `${payload.output}.bvh`];
          }
        }
        if (model === "plant-link") {
          const outside = path.join(path.dirname(payload.output), "..", "outside.bvh");
          writeFileSync(outside, "BVH-OUTSIDE\n");
          symlinkSync(outside, `${payload.output}.link`);
          symlinkSync(path.dirname(outside), `${payload.output}-linkdir`);
        }
        send(200, {
          ok: true,
          files,
          seed: payload.seed,
          metaSeed: payload.meta?.seed,
          bvh: payload.bvh,
          ...(payload.loop && model !== "no-loops" ? {
            loops: Array.from({ length: payload.numSamples - (model === "short-loops" ? 1 : 0) }, (_, k) => (BAD_WINDOWS[model]
              ?? { first: 3 + k, last: 223 + k, poseCost: 0.03, velocityCost: 0.2 })),
          } : {}),
          bvhStandardTpose: payload.bvhStandardTpose,
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
          envKeys: Object.keys(process.env).sort(),
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
