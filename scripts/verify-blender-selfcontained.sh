#!/usr/bin/env bash
# The sealed Blender carries every library it loads except the libc family. Run in a container with no X or GL
# library on it (it needs docker, so it is not in the recipe's test step, whose runner image has X libraries):
#
#   ygg-verify.sh <Vili checkout> <rev> debian:bookworm-slim 'bash scripts/verify-blender-selfcontained.sh'
#
# It downloads the recipe's Blender and Debian inputs (url and sha256 from deployment/idunn/recipe.toml), unpacks them
# with the recipe's own unpack-blender and unpack-blender-libs argv, then asserts: ldd reports nothing missing; every
# shared object the process maps during a real export, run with the daemon's export environment
# (scripts/vili-daemon.mjs exportEnv), is inside the release tree or is libc, libm, libdl, libpthread, librt, libutil,
# libresolv, the dynamic loader, libgcc_s, libstdc++ or libuuid1. Any other host library fails.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils python3 >/dev/null

# The test means nothing if the host can supply what the release should carry. (libmd.so.0 is exempt: dpkg needs it,
# so even the slim image has it; the mapped-library allowlist below still demands that Blender load the release's copy.)
host=$(find / -xdev \( -name 'libX11*' -o -name 'libxcb*' -o -name 'libXext*' -o -name 'libXau*' -o -name 'libXdmcp*' \
  -o -name 'libbsd*' -o -name 'libGL*' -o -name 'libXi.*' -o -name 'libxkbcommon*' \) 2>/dev/null | head -5)
if [ -n "$host" ]; then echo "FAIL: the container carries X or GL libraries: $host"; exit 2; fi

mkdir -p release
python3 - <<'PY'
import hashlib, subprocess, tomllib
recipe = tomllib.load(open("deployment/idunn/recipe.toml", "rb"))
for item in recipe["external_inputs"]:
    if item["id"] != "blender-linux-x64" and not item["id"].startswith("deb-"):
        continue
    subprocess.run(["curl", "-sSfL", "--retry", "3", "--max-time", "900", "-o", item["destination"], item["url"]], check=True)
    assert hashlib.sha256(open(item["destination"], "rb").read()).hexdigest() == item["sha256"], item["id"]
    print("verified", item["id"])
steps = {s["id"]: s["argv"] for s in recipe["steps"]}
for step in ("unpack-blender", "unpack-blender-libs"):
    argv = ["python3" if a == "python3.12" else a for a in steps[step]]
    subprocess.run(argv, check=True)
    print("ran", step)
PY

blender=$PWD/release/blender/blender
lib=$PWD/release/blender/lib
echo "libraries in blender/lib: $(ls "$lib" | wc -l)"

echo "-- ldd"
LD_LIBRARY_PATH=$lib ldd "$blender" > ldd.txt
if grep "not found" ldd.txt; then echo "FAIL: ldd reports missing libraries"; exit 1; fi

echo "-- a real export with the daemon's export environment"
cat > t.bvh <<'BVH'
HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation
  JOINT Spine
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Yrotation Xrotation
    End Site
    {
      OFFSET 0 10 0
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.0333333
0 100 0 0 0 0 0 0 0
0 101 0 0 0 0 5 0 0
0 102 0 0 0 0 10 0 0
BVH
# The daemon's argv and environment exactly (HOME, PYTHONHASHSEED, PYTHONNOUSERSITE, LD_LIBRARY_PATH, PATH, LANG).
daemon_env() { env -i PATH="$PATH" LANG=C HOME=/nonexistent PYTHONHASHSEED=0 PYTHONNOUSERSITE=1 LD_LIBRARY_PATH="$lib" "$@"; }
daemon_env "$blender" -b --factory-startup --python-use-system-env --python-exit-code 1 --python scripts/bvh-to-fbx.py -- \
  "$PWD/t.bvh" "$PWD/plain.fbx" proof | tee export.txt
grep -q '^VILI-FBX ' export.txt || { echo "FAIL: no VILI-FBX line"; exit 1; }
test -s plain.fbx || { echo "FAIL: no FBX written"; exit 1; }

# The same export again inside a wrapper that records what the process mapped when it finished: the loader's own
# account, dlopen included. The FBX must be byte-identical to the plain run.
cat > mapped.py <<'PY'
import runpy, sys
try:
    runpy.run_path("scripts/bvh-to-fbx.py", run_name="__main__")
finally:
    seen = sorted({l.split(None, 5)[5].strip() for l in open("/proc/self/maps") if len(l.split(None, 5)) == 6 and l.split(None, 5)[5].startswith("/")})
    open(sys.argv[sys.argv.index("--") + 1] + ".maps", "w").write("\n".join(seen) + "\n")
PY
daemon_env "$blender" -b --factory-startup --python-use-system-env --python-exit-code 1 --python mapped.py -- \
  "$PWD/t.bvh" "$PWD/mapped.fbx" proof >/dev/null
cmp plain.fbx mapped.fbx || { echo "FAIL: wrapped export differs"; exit 1; }

echo "-- shared objects mapped from outside the release"
outside=$(grep -E '\.so(\.|$)|/ld-linux' mapped.fbx.maps | grep -v "^$PWD/release/" || true)
echo "$outside"
bad=$(echo "$outside" | grep -v -E '^$|/(libc|libm|libdl|libpthread|librt|libutil|libresolv|libgcc_s|libstdc\+\+|libuuid)\.so[.0-9]*$|/ld-linux-x86-64\.so\.[0-9]+$|/libc-[0-9.]+\.so$|/libm-[0-9.]+\.so$' || true)
if [ -n "$bad" ]; then echo "FAIL: host libraries outside the allowlist:"; echo "$bad"; exit 1; fi
for name in libX11 libmd; do
  grep -q "^$PWD/release/blender/lib/$name\." mapped.fbx.maps || { echo "FAIL: $name was not loaded from the release"; exit 1; }
done
echo "SELFCONTAINED-OK"
