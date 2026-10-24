#!/usr/bin/env node
// Stands in for Blender in the daemon's tests. Every start appends a JSON line {pid, pgid, priority, argv, env} to starts.log beside
// this file (the test gives each daemon its own copy, so the log is per test). `--version` answers like Blender,
// unless the copy is named blender-broken. An export (`... -- <bvh> <fbx> <clip>`) acts on the clip name:
//   fail*   prints a line to stderr, exits 1          silent*  exits 0 with no result line
//   hang*   a grandchild, then never exits            slow*    runs 6 s, then behaves
//   other   writes "FBX-STUB:" + the BVH's bytes to <fbx> and prints the VILI-FBX result line
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const here = path.dirname(process.argv[1]);
const log = path.join(here, "starts.log");
const argv = process.argv.slice(2);
const pgid = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[2]);
appendFileSync(log, `${JSON.stringify({ pid: process.pid, pgid, priority: os.getPriority(), argv, env: process.env })}\n`);

if (argv.includes("--version")) {
  if (path.basename(process.argv[1]).includes("broken")) process.exit(1);
  console.log("Blender 0.0.0 (stub)");
  console.log("\tbuild date: never");
  process.exit(0);
}

const [bvh, fbx, clip] = argv.slice(argv.indexOf("--") + 1);
console.error(`stub-blender-stderr ${clip}`);
if (clip.startsWith("fail")) process.exit(1);
if (clip.startsWith("silent")) process.exit(0);
if (clip.startsWith("hang")) {
  spawn(process.execPath, ["-e", `require('fs').appendFileSync(${JSON.stringify(log)}, 'grandchild ' + process.pid + '\\n'); setInterval(() => {}, 1000)`], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  if (clip.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, 6000));
  writeFileSync(fbx, Buffer.concat([Buffer.from("FBX-STUB:"), readFileSync(bvh)]));
  console.log(`VILI-FBX ${JSON.stringify({ bones: 78, frames: [1, 60], fps: 30 })}`);
}
