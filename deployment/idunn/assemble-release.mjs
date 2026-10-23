// Assembles the node half of Vili's sealed release (run by the recipe's node-build runner):
//   node deployment/idunn/assemble-release.mjs release/vili release/node
// release/vili gets the daemon, the Idunn entry, the worker and child sources, the installed node_modules (installed
// with --install-links, so cultcache-ts and cultnet-ts are real copies with their dependencies and no link reaches
// into vendor/), cultcache-py's sources and the lock files the entry hashes; release/node gets the node binary.
// It refuses to finish if any path it wrote is a symlink whose target is absolute: the seal would refuse the tree.
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import path from "node:path";

const [viliOut, nodeOut] = process.argv.slice(2);
if (!viliOut || !nodeOut || process.argv.length !== 4) {
  console.error("usage: assemble-release.mjs <vili output dir> <node output dir>");
  process.exit(2);
}

const copy = (from, to) => cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true });

rmSync(viliOut, { recursive: true, force: true });
rmSync(nodeOut, { recursive: true, force: true });
mkdirSync(path.join(viliOut, "scripts"), { recursive: true });
mkdirSync(path.join(viliOut, "deployment", "idunn"), { recursive: true });
mkdirSync(nodeOut, { recursive: true });

// Runtime sources only: the tests and their fixtures stay out of the release.
for (const entry of readdirSync("scripts", { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(mjs|py)$/u.test(entry.name) || /^test[-_]/u.test(entry.name)) continue;
  copyFileSync(path.join("scripts", entry.name), path.join(viliOut, "scripts", entry.name));
}
copyFileSync("package.json", path.join(viliOut, "package.json"));
copy("node_modules", path.join(viliOut, "node_modules"));
copy(path.join("vendor", "CultLib", "packages", "cultcache-py", "src"), path.join(viliOut, "vendor", "CultLib", "packages", "cultcache-py", "src"));
for (const lock of ["requirements-build.lock", "requirements.lock"]) {
  copyFileSync(path.join("deployment", "idunn", lock), path.join(viliOut, "deployment", "idunn", lock));
}
copyFileSync(process.execPath, path.join(nodeOut, "node"));
chmodSync(path.join(nodeOut, "node"), 0o755);

function refuseAbsoluteLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (lstatSync(full).isSymbolicLink()) {
      if (path.isAbsolute(readlinkSync(full))) {
        console.error(`absolute symlink in the release: ${path.relative(process.cwd(), full)}`);
        process.exit(1);
      }
    } else if (entry.isDirectory()) {
      refuseAbsoluteLinks(full);
    }
  }
}
refuseAbsoluteLinks(viliOut);
refuseAbsoluteLinks(nodeOut);
