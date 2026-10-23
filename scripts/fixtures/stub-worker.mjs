// Stands in for kimodo-resident-worker.py in the daemon's tests. It binds port 0, prints the ready line the
// daemon waits for, and answers /health and /generate with what the daemon gave it.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const host = flag("--host");
let requests = 0;

appendFileSync(path.join(process.env.VILI_EMBEDDINGS_DIR, "stub-spawns.log"), `${process.pid}\n`);

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const send = (body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/health") {
      send({ ok: true, model: "stub-model", displayModel: "Stub Model", pid: process.pid, requests });
    } else if (request.method === "POST" && request.url === "/generate") {
      requests += 1;
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      send({
        ok: true,
        pid: process.pid,
        requests,
        output: payload.output,
        priority: os.getPriority(),
        env: {
          OMP_NUM_THREADS: process.env.OMP_NUM_THREADS,
          MKL_NUM_THREADS: process.env.MKL_NUM_THREADS,
          VILI_THREADS: process.env.VILI_THREADS,
          HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE,
          TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE,
          HF_HOME: process.env.HF_HOME,
          PYTHONPATH: process.env.PYTHONPATH,
          VILI_KIMODO_COMMIT: process.env.VILI_KIMODO_COMMIT,
          VILI_PYTHON_ENV: process.env.VILI_PYTHON_ENV,
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

server.listen(Number(flag("--port")), host, () => {
  console.log(JSON.stringify({ event: "kimodo-worker-ready", port: server.address().port }));
});
