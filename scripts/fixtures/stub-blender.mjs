#!/usr/bin/env node
// Stands in for Blender in the daemon's tests. Every start appends a JSON line {pid, pgid, priority, argv, env} to
// starts.log beside this file (the test gives each daemon its own copy, so the log is per test). `--version` answers
// like Blender, unless the copy is named blender-broken, which names itself and exits 1. An export
// (`... -- <bvh> <fbx> <clip>`) acts on the clip name:
//   fail*     prints a line to stderr, exits 1        silent*   exits 0 with no result line
//   garbage*  an FBX, then a malformed result line   nofile*   exits 0 with a result line and no FBX
//   lies*     an FBX and a result line, exits 3       slow*     runs 6 s, then behaves
//   hang*     a grandchild, then never exits; after SIGTERM it prints a line every 100 ms
//   orphan*   behaves, but leaves a grandchild running when it exits
//   other     writes "FBX-STUB:" + the BVH's bytes to <fbx> and prints the VILI-FBX result line
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const here = path.dirname(process.argv[1]);
const log = path.join(here, "starts.log");
const argv = process.argv.slice(2);
const pgid = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[2]);
appendFileSync(log, `${JSON.stringify({ pid: process.pid, pgid, priority: os.getPriority(), argv, env: process.env })}\n`);

if (argv.includes("--version")) {
  console.log("Blender 0.0.0 (stub)");
  console.log("\tbuild date: never");
  process.exit(path.basename(process.argv[1]).includes("broken") ? 1 : 0);
}

const result = `VILI-FBX ${JSON.stringify({ bones: 78, frames: [1, 60], fps: 30 })}`;
const grandchildren = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("grandchild ")).length : 0);
const spawnGrandchild = () => spawn(process.execPath, ["-e", `require('fs').appendFileSync(${JSON.stringify(log)}, 'grandchild ' + process.pid + '\\n'); setInterval(() => {}, 1000)`], { stdio: "ignore" });

const [bvh, fbx, clip] = argv.slice(argv.indexOf("--") + 1);
console.error(`stub-blender-stderr ${clip}`);
if (clip.startsWith("fail")) process.exit(1);
if (clip.startsWith("silent")) process.exit(0);
const writeFbx = () => writeFileSync(fbx, Buffer.concat([Buffer.from("FBX-STUB:"), readFileSync(bvh)]));
if (clip.startsWith("garbage")) {
  writeFbx();
  console.log('VILI-FBX {"bones":"many","frames":[1],"fps":30}');
  process.exit(0);
}
if (clip.startsWith("lies")) {
  writeFbx();
  console.log(result);
  process.exit(3);
}
if (clip.startsWith("nofile")) {
  console.log(result);
  process.exit(0);
}
if (clip.startsWith("hang")) {
  spawnGrandchild();
  process.on("SIGTERM", () => setInterval(() => console.error("after-sigterm-line"), 100));
  setInterval(() => {}, 1000);
} else {
  if (clip.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, 6000));
  if (clip.startsWith("orphan")) {
    const before = grandchildren();
    spawnGrandchild().unref(); // a live child would keep this process, and so the export, alive
    for (let waited = 0; grandchildren() === before && waited < 3000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  writeFbx();
  console.log(result);
}
