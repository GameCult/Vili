# Motion pipeline map

The prose half of campaign `motion-pipeline`. Questions, rulings, cut specs,
reports, verdicts and findings are typed documents in the eureka mind; this page
keeps only what no kind carries: body facts, the model page, rationale and the
cuts not yet mapped. The target's rationale is `docs/motion-pipeline-target.md`.

## Body facts

### FBX export on Yggdrasil, 2026-10-24

Imagination (imagination-vili-fbx-r3, session sp-reentry-2026-10-21), for
`motion-pipeline:cut_spec:cut-vili-fbx-export.r3`. Source reads are Vili main `c5cf445`. On Yggdrasil,
everything ran as `gamecultadmin` in `~/scratch/imagination-vili-fbx-r3` (removed afterwards, `df` unchanged at
1.3 TB free), with `sudo -n` used only to read the live state root and for `docker run --rm` probes. The live unit
`idunn-vili-43ee8c6f...` (release `sha256-5f0df659...`, 1.8 GB) and `/var/lib/gamecult/vili` were not changed.
Raven was not touched. Host load was about 1.0 on 16 vCPU.

| Probe | Result |
|---|---|
| Blender in the recipe | Absent. `deployment/idunn/recipe.toml` at `c5cf445` has one external input (CPython) and the artifacts `node`, `vili` and `python`. No Blender exists anywhere on Yggdrasil (`find / -maxdepth 7 -name 'blender-5*'`). The tree Idunn sealed in its `big_tree_seals_from_env` test (`idunn-deploy-provenance:cut_report:cut-tree-executable-members.h2`) is gone. |
| Blender download | `https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz`, 383,295,504 bytes, sha256 `84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168`, which matches upstream `blender-5.2.2.sha256`. It unpacks to 1.2 GB: 6,547 entries, 79 symlinks, none absolute. `blender -b --version` prints `Blender 5.2.2 LTS (hash d13f752e3b9c built 2026-09-15 01:34:58)`. |
| Shared libraries | On the host (Debian 13.6), `ldd blender` reports 7 missing: `libXrender.so.1`, `libXfixes.so.3`, `libXi.so.6`, `libxkbcommon.so.0`, `libSM.so.6`, `libICE.so.6`, `libGL.so.1`. Blender exits 127 before `main`. The `python-build` runner image (`buildpack-deps:bookworm@sha256:ccb050a4...`) lacks `libXfixes`, `libXi`, `libxkbcommon` and `libGL`. The binary's `RUNPATH` is `$ORIGIN/lib`, but `libGL.so.1` resolves `libGLX` and `libGLdispatch` without it (RUNPATH is not inherited), so `LD_LIBRARY_PATH=<blender>/lib` is needed as well. |
| Bundled libraries | Nine bookworm debs (`apt-get download` in the runner image) hold every missing library and its dependencies: libxrender1 1:0.9.10-1.1 `b2a6d160...`, libxfixes3 1:6.0.0-2 `1cd61639...`, libxi6 2:1.8-1+b1 `6c2fb5f2...`, libxkbcommon0 1.5.0-1 `e3fe045b...`, libsm6 2:1.2.3-1 `22a42089...`, libice6 2:1.0.10-1 `452796e5...`, libgl1 1.6.0-1 `6f89b170...`, libglx0 1.6.0-1 `95f568df...` and libglvnd0 1.6.0-1 `b6da5b15...` (the full digests are in the cut spec). Their `usr/lib/x86_64-linux-gnu/*.so*` (18 entries, symlinks relative) are copied into `blender/lib`. With `LD_LIBRARY_PATH=<blender>/lib`, nothing is missing on the host or in the runner (`--network none --read-only --user 65532`), and Blender runs in both. |
| A generated clip | The live release's own interpreter and worker (`python/bin/python3.12 vili/scripts/kimodo-resident-worker.py`), run at nice 10 with 8 threads, the models root read-only and a scratch copy of the live embedding cache. The prompt was 'A person walks forward happily, pumping both fists in the air to celebrate.', 3 s, seed 7, `bvh` and `bvhStandardTpose`. The worker was ready in 11 s. Generation took 53.3 s the first time (an encoder miss) and 15.0 s the second (a hit). Both runs produced 90 frames at 30 fps, and their BVH (sha256 `e2d29634...`) and NPZ (`bf7def08...`) were byte-identical. |
| BVH layout (Kimodo `kimodo/exports/bvh.py`, as installed in the release) | `ROOT Root` is a wrapper at the origin whose channels are keyed to zero. `JOINT Hips` carries the 6-channel world trajectory in cm. So the travel is on Hips: across the clip Hips moved 2.56 m forward (Blender `-Y`) in 2.97 s. |
| Conversion | The r2 settings (BVH import at `global_scale 0.01`, `axis_forward -Z`, `axis_up Y`; FBX export with no leaf bones, full bake and `simplify 0.0`), in a scratch `bvh_to_fbx_probe.py`. Per 3 s clip: 1.1 to 4.0 s wall (cold first), 2.6 to 4.6 s CPU, 350 to 377 MB max RSS. Output: 78 bones (`Root, Hips, Spine1...`), frames 1-90, Hips at rest 1.00 m, Head 1.598 m, and a 949,388-byte binary FBX. The rest BVH (`kimodo/assets/skeletons/somaskel77/somaskel77_standard_tpose.bvh`, 1 frame) gives a 457,852-byte FBX with Hips at 1.00 m. |
| Determinism | Two exports of one BVH differ in 15,126 bytes. One cause is FBX object UUIDs: `io_scene_fbx/fbx_utils.py:826-842` `_key_to_uuid` uses Python `hash()` on strings, which is randomized per process. Blender ignores `PYTHONHASHSEED` unless it gets `--python-use-system-env`. The other cause is `CreationTimeStamp`: `export_fbx_bin.py:3235` calls `datetime.datetime.now()`; `FileId` and `CreationTime` are already constants. With `PYTHONHASHSEED=0` and `--python-use-system-env`, and with the script replacing that module's `datetime` by a fixed 1970-01-01, the output is byte-identical: across two processes, across the BVHs of two generation runs, and under `env -i` with `HOME=/nonexistent` and `PYTHONNOUSERSITE=1`. sha256 `f92bd412d0cd78657ed68677564bbd31ca238f4f2c6b34c0a596efb064bc0fc9`, both with the host's trixie libraries and with the bundled bookworm ones. Changing only the seed flag still varies the UUIDs; changing only the time pin still varies 2 timestamp bytes. Decoded with Blender's own `parse_fbx`, those variants have identical values (max diff 0). |
| Across glibc | The same BVH exported in the bookworm runner and on the trixie host gives FBX files 80 bytes apart. Decoded, 2,224 of 9,680 elements differ, all `AnimationCurve` values and `Model` properties, by at most 4.2e-5. So the FBX is byte-reproducible on one host body, and the BVH is the reproducibility unit across bodies. |
| Re-import (Blender) | The FBX imports back as one armature with scale 1, 78 bones, SOMA names, no `mixamorig`, 90 frames and the same Hips trajectory. The take is named after the scene, so the script renames the scene to the clip name (the take then reads `winner_probe`). |
| Unity import smoke (Starfire, Unity 2021.3.45f2 batchmode, a scratch project in the session scratchpad, never the StreamPixels checkout) | Rest FBX as Human/CreateFromThisModel: `isValid True`, `isHuman True`, 79 transforms, Hips y 1.000, Head y 1.598, root scale 1, `fileScale 1`. The auto-map is off by one in the fingers (`LeftHandIndex1 -> Left Index Proximal`), as recorded on 2026-10-23, which is the avatar cut's table to fix. Clip as Human/CopyFromOther: `humanMotion True`, length 2.9667 s (89/30), `hasRootCurves True`, `averageSpeed (0.073, 0.030, 0.858)` m/s, `apparentSpeed 0.863`. With Bake Into Pose (XZ, Y, rotation) the same clip is in place: `averageSpeed (0, 0, 0)`. |
| Disk per job | NPZ 587 KB, BVH 207 KB, FBX 949 KB for a 3 s clip: about 1.7 MB. The release grows by about 1.2 GB (Blender) plus the 18 library entries. |

### Admission under Idunn, 2026-10-23

Imagination (imagination-vili-admission, session sp-reentry-2026-10-21), for
`motion-pipeline:cut_spec:cut-vili-admission.r1`. Read-only: `ssh ygg` with `sudo -n` for reads
only, about 21:55 UTC; nothing started, stopped or changed there. Raven was not touched. Source
reads are Vili `f2b35e3`, Idunn `d3222e5`, CultLib `b549d731`, StreamPixels `a213cc6`,
gamecult-ops `a5d5fb1`.

**Yggdrasil:**

| Probe | Result |
|---|---|
| Disk | `/` (also `/srv`, `/var/lib`) 2.0 TB, 646 GB used, 1.3 TB free. `/var/lib/gamecult/idunn/staging` 37 GB, `/var/lib/gamecult/idunn/cache` 1.9 GB; release roots: StreamPixels 11 GB, Ghostlight v1 40 GB. |
| Idunn body | Unit `idunn-yggdrasil.service`, `/usr/local/bin/idunn serve --bindings-dir /etc/gamecult/idunn/bindings ...`; the binary is dated 2026-10-20, so it predates `d3222e5` (merged 2026-10-23). No `version` subcommand. |
| Bindings | ghostlight, heimdall, odin, raven-muninn, streampixels-service, streampixels-web. Every systemd target uses `strategy = "candidate-then-promote"`; only the Raven host actuator uses `stop-then-start`. Stable endpoints in use: 8831, 8832, 8833, 4100 (loopback), Odin `rudp://10.77.0.1:17871`. Private ranges in use: 18831-18839, 18841-18849, 18851-18859, 14101-14109, 17972-17979. |
| Free ports | `ss -ltn` shows nothing on 8824, 8825 or 18860-18869. |
| StreamPixels service binding (the precedent) | Runner `node-build`: `node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c`, user `65532:65532`, `allowed_programs = ["npm","node","corepack"]`, `network_profile = "bridge"`, cache `/var/lib/gamecult/idunn/cache/streampixels-node`. Workload: `state_group`, `release_root`, `state_root`, `runtime_root`, `network = "host-private"`, `hardening = "strict"`, `read_only_paths`. `[runtime_identity]`, `[route]` (`nginx-stream-tcp`), `[process_write_lease] record_path = <runtime_root>/process-write-lease.cc`, two distinct brake stores, `[rollout] retain_releases = 2`. |
| Probe body | `~/scratch/vili-ygg-cpu/hf2` (18 GB) is an `HF_HOME`: `hf2/hub/models--{meta-llama--Meta-Llama-3-8B-Instruct, McGill-NLP--LLM2Vec-Meta-Llama-3-8B-Instruct-mntp, ...-mntp-supervised, nvidia--Kimodo-SOMA-RP-v1.1, nvidia--Kimodo-SOMA-RP-v1.2}`. Kimodo checkout `~/scratch/kimodo-cpp-probe/kimodo` at `6bb58488037dd65360ff0c5d1692b403a23309f7`, 79 MB without `.git`; `MotionCorrection/` (CMake, `setup.py`, `src/`, `python/`) is a subdirectory of that repo. Kimodo's `docker_requirements.txt` takes `py-soma-x @ git+https://github.com/NVlabs/SOMA-X.git` unpinned; the probe image's build log resolved it to `56a3d957a549c66425b500fddf7f3183bc6fbdff`. |
| python-build-standalone | Upstream `SHA256SUMS` of release `20261021`: `cpython-3.12.15+20261021-x86_64-unknown-linux-gnu-install_only.tar.gz` is `5ff9f0602ce964a529ed1e8555d3abab6341926d724402ba9a15e9e877191124`. |

**Idunn source at `d3222e5`:**

- Recipe shape (`src/deployment.rs:36-129`): `external_inputs` are `{id, url, sha256, runner, destination}`;
  an artifact has `executable` or `executable_members` (relative regular-file paths inside a
  directory artifact), never both (`:919-927`). Destinations are single filenames and unique.
- External inputs are fetched before any step, by `curl --proto =https` inside the named runner's
  container, into that runner's workspace, and refused unless the sha256 matches
  (`src/drivers.rs:2216-2275`, order `:2330-2390`). Each runner gets its own copy of the frozen
  source; steps run in `docker run --read-only` with `/workspace` the only writable mount besides
  `/cache`, and `/tmp` a `noexec` tmpfs (`src/drivers.rs:2078-2130`). The network is the binding's
  `network_profile` (`none`, `bridge` or a named network, `:2049-2053`).
- Seal (as merged, verdict `idunn-deploy-provenance:verdict:cut-tree-executable-members.s3`): files
  0444 except `executable_members` at 0555; a link must be relative, with every `..` leading and no
  more of them than the link's depth below the artifact top. The real PBS 3.12.15 + torch 2.5.1 +
  Blender 5.2.2 tree sealed with all 1,128 links (300 terminfo `..` links among them). A
  `python -m venv` on PBS makes `bin/python3.12` an absolute link, which the seal refuses (s2
  claim on `vili-worker-venv-in-release`). The ignored test `big_tree_seals_from_env`
  (`src/drivers.rs:14434`) seals a directory named by `IDUNN_BIG_TREE` holding `python/` and
  `blender/`.
- Readiness class (`src/control_plane.rs:691-747`): a routed target with no `odin.verse-rendezvous`
  dependency is `RouteProof`, admitted by Idunn's own challenge with no Odin. A stateful
  route-proof target is Ready when it answers the challenge `active` while holding the exact
  lease (`:7895-7948`). The challenge is `POST /cultnet/snapshot` with
  `Content-Type: application/msgpack` (`src/drivers.rs:719`, `:5982`).
- Rollout (`docs/deployment-authority.md:245-300`): the candidate starts privately, proves
  `warming`, the incumbent's writer is fenced and "must return a retryable unavailable result",
  then the candidate gets its own write lease, then Ready, then the route, then the incumbent
  drains.
- State slot kinds are `cultcache-file`, `external-file` and `external-directory`; writers
  `process-bound-single-writer` or `none`; recovery `preserve`, `rebuildable` or
  `external-authority`; startup `create-or-open-after-write-lease` or `open-at-start`
  (`src/deployment.rs:171-235`).
- Idunn's own unit (`deploy/idunn-yggdrasil.service:66-106`) runs `ProtectSystem=full` and lists
  each managed target's runtime, state and release roots in `ReadWritePaths`; a target missing
  there fails at "creating runtime bundle" (`docs/migration.md`, host prerequisites).

**The StreamPixels pattern, read:**

- `deployment/idunn/runtime-presence.mjs:25-91` (StreamPixels): `loadIdunnRuntimeAuthorityFromEnvironment`,
  `createIdunnRuntimeSigner`, then the write lease through its Odin publisher. The lease check is
  local: `signer.assertWriteLease()` reads the lease record and needs no Odin (CultLib
  `packages/cultnet-ts/src/idunn-odin-presence-publisher.ts:68-82`,
  `idunn-runtime-authority.ts:100-121`).
- `apps/service/src/app.ts:166-195`: `POST /cultnet/snapshot` decodes a msgpack
  `cultnet.snapshot_request.v0` and answers `signer.answerRouteObservation(request)` as
  `cultnet.snapshot_response_raw.v0`.
- `gamecult-ops/runbooks/streampixels-idunn-v2.md:90-243`: root shapes (`state_root` `2770
  root:<group>`, `runtime_root` `2750`, cache `0700` owned by the runner uid), identity enrolment
  with `idunn-provision`, then `idunn validate --recipe --binding` before `idunn up`.
- `gamecult-ops/idunn/yggdrasil/bindings/*.toml.in` are the checked-in bindings, rendered with the
  provisioned signer id.

**Vili at `f2b35e3`:** the daemon refuses every POST that is not `application/json` or carries an
`Origin` (`scripts/vili-daemon.mjs:147-154`), so Idunn's msgpack challenge would get 403. It
writes the state root before it listens (`:644-645`) and reclaims a predecessor's worker from
`worker.pid` by a `/proc` scan (`:320-350`), which inside Idunn's `PrivatePIDs` sees only its
own namespace. `--health` (`:630-642`) is an HTTP self-probe whose only caller was Raven's
launcher. The child calls `sys.exit(main())` at import (`scripts/kimodo-text-encode.py:78`),
so no test can import it.

### The move to Yggdrasil, 2026-10-23

Imagination (imagination-vili-move, session sp-reentry-2026-10-21), for
`motion-pipeline:ruling:vili-moves-to-yggdrasil-now`, `vili-worker-venv-in-release` and
`encoder-assembly-b`. Read-only: `ssh raven` as encoded PowerShell, `ssh ygg` with `sudo -n`
for reads only. Nothing was started, stopped or changed on either host. The CPU timings, the A/B
clips and Yggdrasil's load profile are `docs/research/vili-on-yggdrasil-cpu-2026-10.md`; they are
not repeated here.

**Raven, 2026-10-23 about 09:45 UTC:**

| Probe | Result |
|---|---|
| Scheduled tasks under `\GameCult\` | `Vili` (Ready; boot trigger) runs `wscript.exe run-hidden-powershell.vbs ... start-vili-daemon.ps1 -Port 8824 -HostName "127.0.0.1,10.77.0.4" -StateRoot "E:\Projects\Vili\.vili" -IdunnRudpHealth "10.77.0.2:17870" ...`. `ViliTray` (Running; `MSFT_TaskLogonTrigger`) runs `vili-gpu-tray.ps1 -Port 8824`. `Backup-Yggdrasil-Pull` and `ComfyUI` are not Vili's. |
| Processes | node PID 31324 `E:\Projects\Vili\scripts\vili-daemon.mjs --host 127.0.0.1,10.77.0.4 --port 8824 --state-root E:\Projects\Vili\.vili`, listening on `127.0.0.1:8824` and `10.77.0.4:8824`. powershell PID 4540 is the tray. |
| Checkout | `E:\Projects\Vili`, detached HEAD at `3adb616`, the head of the unmerged `cut/raven-gpu-tenancy-gate` (26 commits past main's merge base, 4 behind main). The inventory's `F:\Projects\Vili` on Raven is stale. |
| State | `E:\Projects\Vili\.vili`: artifacts 58 files 7.8 MB, jobs 17 files, probe 59 files 1.0 MB, logs 2, embeddings `text-embeddings.cc` 138,633 bytes (assembly A vectors, GPU bf16), plus the JSON sidecars and `vili.service.cc`. |
| WSL `Ubuntu-24.04` Docker | Container `vili-kimodo-worker` Exited (137), stopped about 8 h earlier. Image `gamecult/kimodo:latest` `2e11f33e57b1` 35 GB; `nvidia/cuda:12.4.1-base-ubuntu22.04` 348 MB (the daemon's runtime probe); `nvidia/cuda:12.6.3-devel-ubuntu24.04` 11.5 GB (owner unproven). |
| WSL host paths | `/root/.cache/huggingface` 17 GB holding only Vili's repos (Llama base, the two McGill adapters, SOMA-RP v1.1). `/opt/gamecult/kimodo` (the Kimodo checkout the image and the daemon read) and `/opt/gamecult/kimodo-runs` sit beside `bonsai`, `comfyui` and `sillytavern`, which are not Vili's. |

**Yggdrasil, 2026-10-23 09:44 UTC:**

| Probe | Result |
|---|---|
| Host | `yggdrasil-candidate`, 16 vCPU, 62 GiB (58 available), load 1.22; `/` 2.0 TB, 1.3 TB free. Host `node` v24.14.1; host `python3` 3.13.5, which cannot run Kimodo's `numpy==1.26.4` pin (no cp313 wheels). |
| Huginn | `huginn.service`, an interim unit: `MemoryMax=768M`, `Nice=0`, no `CPUWeight`, no CPU quota. |
| Probe body left by the CPU research | Image `vili-cpu-probe:1` (`11fa6c3dbb4e`, 4.66 GB): python:3.12, torch 2.5.1+cpu and Kimodo's pins (`~/scratch/vili-ygg-cpu/Dockerfile`). `~/scratch/vili-ygg-cpu/hf2` (18 GB) in hub layout: `meta-llama/Meta-Llama-3-8B-Instruct`, both McGill adapters, SOMA-RP v1.1 and v1.2. Kimodo at `6bb58488037dd65360ff0c5d1692b403a23309f7` in `~/scratch/kimodo-cpp-probe/kimodo`. Assembly B as the probe built it: `~/scratch/vili-ygg-cpu/encode.py` lines 33-39. The run harness is `run.sh` there. |
| Idunn bindings | `/etc/gamecult/idunn/bindings/`: ghostlight, heimdall, odin, raven-muninn, streampixels-service, streampixels-web. Every systemd target is `network = "host-private"`, `hardening = "strict"`. HTTP routes are `nginx-stream-tcp` on `127.0.0.1` stable endpoints; Odin's `nginx-stream-udp` route has the WireGuard stable endpoint `rudp://10.77.0.1:17871`. Workload limits: StreamPixels service 2048 MiB / 200 %, Ghostlight 8192 MiB / 400 %. Build runners are digest-pinned docker images with `network_profile` `bridge` or `build-dependency-egress`. |
| StreamPixels service, the precedent | Recipe `StreamPixels deployment/idunn/service.toml`: `required_gitlinks = ["vendor/CultLib"]`, node-build steps, a `node` executable artifact plus a `service` tree artifact, health `gamecult.runtime_presence_health.v2` answered through `cultnet-ts/idunn-runtime` (`deployment/idunn/runtime-presence.mjs`), CultCache state slots. Binding: `read_only_paths = ["/srv/streampixels/content"]`, `[runtime_identity]`, `[process_write_lease]`, `[rollout] strategy = "candidate-then-promote"`, so two incarnations overlap during a rollout. |

**Idunn source, main `6e2a31c`:**

- An artifact `destination` must be a single filename (`require_leaf_path`, `src/deployment.rs:1837-1844`), and destinations are unique (`:839-843`).
- Sealing makes every directory 0555 and every file 0444 except the artifacts declared `executable`, which are matched by destination path (`harden_installed_release`, `src/drivers.rs:6749-6793`). A file inside a tree artifact can never be executable. Symlinks survive only when relative and inside the release (`validate_release_symlink`, `:6796-6815`).
- `external_inputs` are fetched by `curl --proto =https` inside a named runner and checked against `sha256` (`materialize_external_input`, `src/drivers.rs:2215`).
- The transient unit carries `MemoryMax`, `CPUQuota`, `DynamicUser`, `PrivateTmp`, `ProtectSystem=strict`, and no `MemoryDenyWriteExecute`, so torch's oneDNN JIT can run (`src/drivers.rs:3634-3700`). There is no `CPUWeight` or `Nice` knob.
- `docs/migration.md:283-293` names the Python gap: a release needs "a wheel, or a venv materialized into the release root".

**Consumers of Raven's address.** `git grep` for `10.77.0.4:882`, `raven.vili` and `:8824` across
StreamPixels, gamecult-ops, Odin, Idunn, Huginn, Eureka, Ghostlight, Heimdall, Bifrost and Vili found
no code that calls Vili. The hits are Vili's own defaults and README (`scripts/vili-daemon.mjs:19-20`,
`:222-224`, `scripts/smoke-vili.mjs:2`, `README.md:41`), gamecult-ops `inventory.md:20` and `:321`
(docs), and Odin's transport inventory, which records the address as gone from Odin. The live callers
are agents running `POST /motion/generate` by hand from Starfire over WireGuard.

### Community tooling re-map, 2026-10-23

Imagination (imagination-unity-remap, session sp-reentry-2026-10-21), for
`motion-pipeline:ruling:remap-against-community-tooling` under
`own-implementation-borrow-best`. Inputs: `docs/research/kimodo-community-tooling-2026-10.md`
and shallow clones read on Starfire, nothing run except the Unity probes below.

| Tool (commit read) | Licence | What it is, as read |
|---|---|---|
| Amin-HP/Kimodo-Unity (`fb62ab4`) | Apache-2.0 | `Runtime/KimodoSomaHumanoid.cs` builds a SOMA rig at runtime from rest offsets and calls `AvatarBuilder.BuildHumanAvatar` for live NPZ playback. Body table equals ours; fingers map `*1/2/3` to Proximal/Intermediate/Distal. Unity 6000.0+. |
| OneYoungMean/KimodoUnityBridge (`bb215bc`) | Apache-2.0 | Ships `Runtime/Resources/SOMAAvatar.asset` (compiled Avatar, 55 human bones, 231 skeleton entries) and `Editor/Model/SOMA77.fbx`, an ASCII FBX 7.7 written by FBX SDK 2020.3.2, cm units, a visualisation rig (BoneSegment and JointViz meshes, Hips at the top, Hips at y 0). Same finger map as Amin-HP. Package declares Unity 2022.3. |
| Codemarchant/kimodo_NPZ_to_fbx_and_vrma (`d12af73`) | MIT | `backend/fbx_writer.py`: NPZ to skeleton-only FBX through the FBX SDK, Mixamo names, MayaYUp, cm, Euler XYZ. README: FBX SDK wheels stop at Python 3.10. |
| micahmills88/animation-builder (`095addf`) | Apache-2.0 | `app/npz_to_fbx.py`: NPZ retargeted onto a user's Mixamo FBX through `fbxsdkpy==2020.1.post2` from Inria's GitLab index; port of ComfyUI-Kimodo's retargeter. |
| GuardSkill/ComfyUI-Kimodo-Bridge (`073badc`) | Apache-2.0 | `kimodo_retarget_fbx.py`: same FBX-SDK retarget onto a Mixamo rig, plus a Unity AssetPostprocessor in a ZIP bundle. |
| wifimetas/kimodo-mcp (`83b5361`) | Apache-2.0 | `blender_export.py` 'unity' preset: headless Blender BVH to FBX with `axis_forward -Z`, `axis_up Y`, `add_leaf_bones False`, full bake, `bake_anim_simplify_factor 0.0`, metric `scale_length 1.0`. The same settings as `cut-vili-fbx-export`. |

Unity probes, Starfire, Unity 2021.3.45f2 batchmode, scratch project (never the
StreamPixels checkout), one job at a time, detached with log and PID
(PIDs 28132 and 38260):

| Probe | Result |
|---|---|
| Load `SOMAAvatar.asset` (Avatar serializedVersion 3) | `isValid True`, `isHuman True`, 55 human, 231 skeleton. 2021.3 reads it. |
| Import their `SOMA77.fbx` with their 2022.3 `.meta` (serializedVersion 22200) | Human, CreateFromThisModel, `isValid True`, `isHuman True`; Hips y 0.000, Head y 0.598, root scale 1, humanScale 0.991. 2021.3 reads FBX 7.7 and the newer meta. |
| A copy with no meta and an `OnPreprocessModel` that sets only `humanDescription.human` (skeleton empty) to our table | The avatar came out auto-mapped: `LeftHandIndex1 -> Left Index Proximal`. The human-only hook does not hold. |
| A copy where an editor method sets `human` to our table and `skeleton` from the model's transforms, then `SaveAndReimport` | `isValid True`, `isHuman True`, 55 human; `LeftHandIndex2 -> Left Index Proximal`, `Index3 -> Intermediate`, `Index4 -> Distal`, `Chest -> UpperChest`. |
| SOMA77 finger offsets (from `SOMAAvatar.asset` skeleton) | Hand to Index1 4.0 cm, Index1 to Index2 6.4 cm, Index2 to Index3 3.7 cm, Index3 to Index4 2.3 cm: `*1` is the metacarpal base, `*2` the knuckle. |

What follows, and what does not:

- 2021.3 can read both community assets, but neither can be our source avatar.
  `CopyFromOther` binds a clip to the source avatar's hierarchy, and theirs is a
  visualisation rig, not the Root/Hips hierarchy Vili's `bvh-to-fbx.py` writes.
  Importing it would also make a foreign asset an owner, which
  `own-implementation-borrow-best` rules out.
- What is borrowed is a cross-check, not code: the body table matches both Unity
  bridges, and the Blender settings match kimodo-mcp's Unity preset. No file is
  copied, so attribution is a header comment naming the repos and commits; a
  NOTICE entry is owed only if Hands copies code after all.
- Both community finger maps are off by one joint (metacarpal as Proximal). Ours
  maps `*2/3/4`. Unity's own auto-mapping makes the same choice as theirs, which
  is a second reason the table is committed rather than auto-mapped.
- The FBX-SDK writers were read, not run. Their output quality on LHMP is
  unmeasured; the rejection below rests on dependency and authority, not quality.

## Model page

`<state>` is the daemon's state root: `--state-root`, `/var/lib/gamecult/vili` once Idunn admits
Vili. `<models>` is `--models-root`, `/srv/vili/models` on Yggdrasil.

| Kind | Named by | Over time | Decided by |
|---|---|---|---|
| Worker process | the daemon's one child, `kimodo-resident-worker.py` on `127.0.0.1:<ephemeral>` | spawned at daemon start (or on first job), restarted by the daemon if it exits, killed when the daemon exits; never outlives its parent | the daemon; the worker owns only generation inside it |
| Encoder child | one per request with cache misses, spawned by the worker | lives about a minute on CPU (55 s cold, 14.3 GiB peak), then exits | the worker's `CachedTextEncoder`; assembly B, CPU, bf16 |
| Motion job (`<state>/jobs/<jobId>.json`) | `vili-<epoch ms>` | written once when a job ends | the daemon |
| Text embedding (`<state>/embeddings/text-embeddings.cc`) | `sha256(identity, text)`; the identity names assembly, device, dtype, the three repo revisions, torch, transformers, peft, accelerate, the Kimodo commit and the encoder child's own sha256 | appended on miss; a changed identity misses and leaves old rows inert | the worker's cache. Raven's file (assembly A on GPU) is not carried over |
| Clip artifact (`<state>/artifacts/<jobId>/motion*.bvh`, `motion*.fbx`, Kimodo's `meta.json`) | the job id; `clipName` names the FBX's armature, action and take | written once per job, never rewritten. The BVH is the reproducibility unit across host bodies, and the FBX is byte-identical for one BVH on one body. Read back through `GET /motion/artifacts/<jobId>/<file>` | the daemon (export, under the same write gate as generation) from Kimodo's BVH; Blender only converts. Planned by `cut-vili-fbx-export` r3 |
| Clip provenance (the job record `gamecult.vili.motion_job.v1`) | the job id | written once when a job ends; it carries the seed used (minted when absent), the worker's model, encoder and Kimodo identity, the export block (Blender version, script sha256, the determinism settings, clip names) and the sha256 of every artifact file | the daemon. Still JSON until `vili-jobs-cultcache` |
| Blender (`blender/` in the release: Blender 5.2.2 LTS linux-x64 plus sixteen bookworm libraries in `blender/lib`) | the tarball's sha256 and the sixteen debs' sha256 (rulings blender-libs-bundled-in-release and blender-x-libs-bundled-in-release), all `external_inputs` | rebuilt into each release, sealed 0444 with `blender` the one 0555 member; run once per exported clip | the recipe; the daemon spawns it with a fixed environment |
| Model weights (`<models>` = `HF_HOME`, hub layout under `hub/`, with `SHA256SUMS` beside it) | repo id and snapshot revision | provisioned by agents on the host, checked once with `sha256sum -c` at provisioning; read-only to Vili (`read_only_paths`); changed only by a new manifest | host provisioning (runbook `gamecult-ops/runbooks/vili-idunn.md`); the worker's identity records the snapshot revisions it loaded |
| Worker environment (`python/` in the release: PBS CPython 3.12.15 with the two hash-locked requirement files and Kimodo, MotionCorrection and SOMA-X installed into its own site-packages; no venv) | `cpython-3.12.15+20261021` plus the sha256 of the two lock files, computed by the Idunn entry from the sealed files | rebuilt by the recipe on each release, sealed 0444 with `bin/python3.12` the one 0555 member | the recipe (`worker-python-pbs-in-release`) |
| Writer authority over `<state>` | under Idunn: the process write lease Idunn grants this incarnation; run by hand: `<state>/daemon.lock`, a Unix socket the live daemon listens on | lease: granted after the incumbent is fenced, checked every 5 s, lost on fence; lock: taken at start, refused while another daemon answers on it, reclaimed when stale | Idunn (lease); the daemon run by hand (lock). Nothing writes `<state>` before it holds one |
| Worker pid file (`<state>/worker.pid`) | the worker's process group | written at spawn, removed at exit; read once at start to kill a crashed predecessor's worker | the hand-run daemon only. Under Idunn the unit's cgroup owns the tree and no pid file is written |
| Vili service store (`<state>/vili.service.cc`) | `vili` | rewritten every 5 s with operator state, command boundary and transport profile | the daemon; no Eve surface or provider advertisement after `cut-vili-cpu-body` |
| SOMA Humanoid table (StreamPixels `Assets/Editor/Motion/SomaHumanoid.cs`) | SOMA77 joint names to `HumanBodyBones` | changes only by code edit, then `ApplyToRest` rewrites the rest FBX's `.meta` | the engine; planned by `cut-soma-humanoid-avatar` |

## Rationale

### The move to Yggdrasil

**Target body.** One Idunn `systemd-transient` target, `vili`, on Yggdrasil:

- The Node daemon is the unit's main process. It spawns the Python worker as its child, on
  `127.0.0.1` at an ephemeral port the worker reports in its ready line. The worker spawns one
  encoder child per cache miss. Nothing runs on a GPU, in WSL or in Docker.
- The worker and the encoder child run at nice 10, the verify stopgap's nice, below Huginn's 0.
  torch and OpenMP threads are capped by `VILI_THREADS` (default 8, measured;
  `motion-pipeline:follow_up:ygg-worker-thread-cap`). The unit gets `memory_mebibytes = 20480`
  (2.5 GiB worker, 14.3 GiB encoder peak, daemon and headroom) and `cpu_quota_percent = 800`.
- The encoder is assembly B: the Llama base, the MNTP adapter merged with `PeftModel`, then the
  supervised adapter, bf16 on CPU (`encoder-assembly-b`). The cache identity is complete
  (`embedding-identity-complete`).
- State: `/var/lib/gamecult/vili` (jobs, artifacts, `embeddings/text-embeddings.cc`,
  `vili.service.cc`). Weights: `/srv/vili/models`, host-provisioned, read-only, with a sha256
  manifest the worker checks. The release carries code, the Node binary, CPython 3.12 and the
  locked site-packages, Kimodo at `6bb58488`, SOMA-X and MotionCorrection.
- Bind and consumers: Idunn's `nginx-stream-tcp` route with stable endpoint
  `http://10.77.0.1:8824` (WireGuard only, as Odin's route is), the candidate on
  `127.0.0.1:1886x`. The callers are agents on Starfire and the RPS clip generation script, over
  HTTP `POST /motion/generate`. Cross-site POSTs are refused and no CORS is granted (ported from
  `cb36beb` on the gate branch). Vili publishes typed state to its CultCache store now and to Odin
  over CultMesh RUDP after admission, as StreamPixels does; operator and authoring surfaces wait
  for Thing 2 (`surfaces-wait-for-thing2`).
- Blender for FBX export rides in the same release, as a pinned, sha256-checked Linux tarball
  (`external_inputs`) with `blender` as an executable member, under the same Idunn contract as
  the interpreter. Its missing X and GL libraries ride with it (see "The FBX export" below).

**Why the worker is a child, not a second target.** It has no lifecycle of its own: it is useless
without the daemon, and the daemon is useless without it. A separate Idunn target would buy a
second health contract, a second route and a cross-target dependency to protect no invariant.
Idunn's `KillMode=mixed` and `PrivatePIDs` already bound the tree's lifetime to the unit.

**Why an ephemeral worker port.** `candidate-then-promote` runs two incarnations at once during a
rollout, and both use the host network. A fixed `8825` would make the candidate's worker collide
with the live one's.

**Why nice in process, not an Idunn knob.** Raising one's own nice needs no privilege, and it is
the same lever the verify stopgap uses. Idunn has no `CPUWeight`; adding one would buy nothing
the child's nice and the thread cap do not.

**Threads are provenance, not identity.** A different thread count can change a bf16 reduction in
its last bits, not which encoder made the vector. The embedding key names what makes a vector a
different encoder's (assembly, device, dtype, revisions, library versions, loader source); the
thread count is recorded in the job's provenance.

**Why the interpreter must travel, and how it does.** A venv points at its base interpreter by
absolute path, and Yggdrasil's own Python is 3.13, which Kimodo's numpy pin cannot use. So the
release carries python-build-standalone's relocatable CPython 3.12 with the locked packages
installed into its own site-packages; there is no venv, so there is no absolute `bin/python`
and no `pyvenv.cfg` naming the build workspace. Idunn `d3222e5` seals `bin/python3.12` 0555 as an
executable member and keeps the tree's relative links.

**Why the embedding cache starts empty.** Raven's file holds assembly A vectors made on the GPU.
Under the complete identity none of them can ever hit, and carrying inert rows forward would only
make the file lie about what it holds. A miss costs 55 s once per prompt.

**Why Raven is retired after admission, in its own cut.** The ruling says the old host decides
nothing after the cut-over. `cut-vili-cpu-body` removes every Raven path from main, so no new
Raven body can be made from main. The running Raven daemon is a detached checkout of the unmerged
gate branch with no caller. It is torn down by its own cut, which cannot run until Vili is
admitted under Idunn and answers on Yggdrasil end to end, so Vili is never without a host. Until
then the Raven daemon stays as it is and nothing points at it; the admission cut never touches
Raven (`raven-gpu-defers-to-household`).

**What retires on Raven, in the teardown cut.** The `\GameCult\Vili` and `\GameCult\ViliTray`
tasks are stopped and unregistered (PIDs 31324 and 4540 at probe time); the WSL keepalive loop is
killed; container `vili-kimodo-worker`, image `gamecult/kimodo:latest`, image
`nvidia/cuda:12.4.1-base-ubuntu22.04`, `/opt/gamecult/kimodo` and `/root/.cache/huggingface` (17 GB,
Vili's repos only) are removed once Yggdrasil's `/srv/vili/models` manifest matches; `.vili` and
`/opt/gamecult/kimodo-runs` are archived to `/srv/retired/vili-raven-2026-10/` on Yggdrasil with
their sha256 recorded, then deleted with the `E:\Projects\Vili` checkout. `nvidia/cuda:12.6.3-devel`
stays until its owner is proven. The `cut/raven-gpu-tenancy-gate` branch is not merged; its
cross-site refusal is ported, the rest dies with it.

**Rulings the move overturns.** `vili-idunn-deferred` was superseded by `vili-moves-to-yggdrasil-now`
when the admission cut was mapped: its premise (a Raven host-actuator target, after RPS has
clips) is gone. `raven-gpu-tray-toggle`, `raven-gpu-defers-to-household`, `gpu-defer-refuse-typed`,
`encoder-transient-gpu` and `blender-body-portable` (its Windows zip on Raven) still govern the
Raven daemon that runs until the teardown cut, and Self supersedes them with it. The gate spec
`cut-raven-gpu-tenancy-gate.r2` is withdrawn, and the follow-ups `raven-gate-residue`,
`raven-gpu-tenancy-gate` and `raven-host-ram-ceiling` are moot. `cut-vili-fbx-export.r2` and
`cut-soma-humanoid-avatar.r2` were mapped against Raven; each gets a fresh revision after the
admission cut, not an edit now.

**Eve leaves with the move.** The daemon's Eve surface, deck WebSocket and Eve-schema provider
advertisement are quarantined at tag `parked/vili-eve-surface` (`thing2:ruling:eve-dashboards-quarantined-2`,
the Vili item of `thing2:follow_up:eve-quarantine-remainder`). They named `asgard.raven.vili`, so
the move would have had to rewrite them anyway.

### The admission

**Readiness is route-proof, not Odin-correlated.** Idunn derives the readiness class from the
recipe alone: a routed target with no `odin.verse-rendezvous` dependency is admitted by Idunn's
own challenge and never reads Odin. Vili publishes nothing to Odin yet, and declaring the
dependency only to reach readiness would make admission wait on a publisher that is a later cut.
The daemon answers `POST /cultnet/snapshot` with `signer.answerRouteObservation`, as the
StreamPixels service does, ahead of the cross-site refusal (the challenge is msgpack, never JSON)
but still refusing any `Origin`.

**One writer authority per way of running, decided by the entry.** Idunn's process write lease
is the single-writer owner on Yggdrasil. The Idunn entry listens first (the candidate must answer
the challenge `warming` before Idunn grants a lease), writes nothing, spawns nothing and answers
`503 write-lease-pending` until `assertWriteLease` holds, then opens the state root and reports
`active`. It re-checks the lease on the 5 s state tick; on loss (the incumbent fenced during a
rollout) it stops its worker tree and answers `503 write-lease-lost`, which is the retryable
unavailable result Idunn's rollout asks of a fenced incumbent. Run by hand (tests, development),
the daemon takes `<state>/daemon.lock` instead, a Unix socket it listens on: a second daemon that
can connect to it refuses to start and kills nothing, which closes the s2 case
second-daemon-kills-live-worker. The two never stack: under Idunn a socket lock held by the
fenced incumbent would block the candidate's start until the incumbent drained, which happens
only after the candidate is Ready, a deadlock. The `/proc` reclaim of a crashed predecessor's
worker belongs to the hand-run lock only, because under Idunn the unit's cgroup owns the tree and
`PrivatePIDs` hides other incarnations.

**Candidate-then-promote, not stop-then-start.** Every systemd target on Yggdrasil uses
candidate-then-promote; stop-then-start runs only on the Raven host actuator, so it is unexercised
for a routed systemd target. With the lease gate above, the overlap costs nothing: the candidate
spawns no worker until it holds the lease and gets a job, and the fenced incumbent kills its own.
The ephemeral worker port still matters, because both incarnations share the host network.

**Kimodo and SOMA-X are gitlinks, not external inputs.** A gitlink pins content by commit, and
Idunn already freezes `vendor/CultLib` that way with origins in the binding. A GitHub archive
tarball has no byte-stability guarantee, so a sha256 pin on one can break with no upstream change.
Kimodo's own requirements leave SOMA-X unpinned; the gitlink pins the commit the probe resolved.
MotionCorrection is a directory of the Kimodo repo, so it comes with that gitlink. The
interpreter is the one external input: astral publishes `SHA256SUMS`, and the operator approved
that download (`worker-python-pbs-in-release`).

**Two hash locks and no build isolation.** PBS 3.12 ships pip, and (unprobed, Hands confirms) not setuptools; Kimodo's
pins likely include sdists (hydra's `antlr4-python3-runtime==4.9.3` is believed to be
sdist-only on PyPI; unprobed, Hands confirms when locking) and MotionCorrection is a CMake build.
pip does not hash-check an isolated build's own dependencies, so the build tools (setuptools,
wheel, pybind11, cmake) come first from their own hash lock, and everything after builds with
`--no-build-isolation`. The vendored directories cannot be hashed and install last with
`--no-deps --no-index`. `TMPDIR` points into the runner's cache, because the container's `/tmp` is
`noexec` and CMake's try-compile runs what it builds.

**The weights manifest is checked at provisioning, not at worker start.** Hashing 18 GB on every
worker start costs about a minute against a model load of seconds. The weights are root-owned and
read-only to the unit, so after the one check at provisioning nothing Vili runs can change them.

**`--health` is deleted.** It was an HTTP self-probe whose only caller was Raven's launcher. Under
Idunn, health is signed presence; `GET /health` stays as a plain probe for agents.

**Disk.** Each deploy attempt leaves about 7 GiB in staging and releases until
`ghostlight-verse:follow_up:idunn-generation-retention` lands, so the cut's budget on `/` is
60 GiB: the 18 GiB weights copy, up to four deploy attempts, the runner caches and the dry-run
trees, which are removed when the dry run ends. Hands stops if free space on `/` falls below
1.2 TB.

### The FBX export

**The FBX carries the true trajectory, on Hips.** Kimodo's BVH keeps the `Root` wrapper still at
the origin and puts the world translation on `Hips`. Vili passes that through unchanged. Unity's
Humanoid importer turns the body's motion into root curves (`hasRootCurves`), so one FBX serves both
uses: root motion (`applyRootMotion`, 0.858 m/s forward on the probe clip) or in place (Bake Into
Pose, after which `averageSpeed` reads 0). The speed for in-place use is the engine's measurement:
read `averageSpeed` on the root-motion import, which Unity scales by the target avatar's
`humanScale`. Vili does not export in place and does not compute a speed. Taking the travel out
is lossy, it is a per-consumer choice, and with the trajectory gone, the foot contacts Kimodo's
post-processing fixed would slide. A speed computed in Vili would be in SOMA metres, a measurement
that belongs to the engine (`engine-owns-retargeting`). Whether the RPS exits use root motion or
in-place with that speed is the slot-clips work's choice
(`rps:ruling:rps-duelists-exit-celebrating-moping`). The run-in precedent points to in-place with a
speed, because the overlay already moves each duelist itself.

**Determinism is three settings, and each is pinned by a test.** `PYTHONHASHSEED=0` with
`--python-use-system-env` fixes the FBX object ids, and the script replaces `export_fbx_bin`'s
`datetime` with a fixed 1970-01-01 so the header stamp stops varying. The script refuses to run while
`sys.flags.hash_randomization` is set. So a missing flag fails the export instead of quietly
producing bytes that differ between runs. The provenance records real times; the file's own header
time is a constant. Across host bodies (glibc 2.36 against 2.41) the curves differ by up to 4.2e-5,
so a golden FBX hash cannot be checked in the runner. The recipe's test checks that the export
repeats within one body and checks the file's structure. The BVH is the unit compared across bodies.

**Blender's libraries travel in the release.** Neither Yggdrasil (trixie) nor the `python-build`
runner (bookworm) has Blender's seven X and GL libraries. Installing host packages would leave the
build-time test without them, and would make the release depend on an apt step that no recipe can
check. Bookworm's builds run on both bodies, because glibc is backward compatible. So the sixteen debs
are sha256-pinned `external_inputs` from snapshot.debian.org, which keeps a fixed URL after a point
release removes a version from the pool. One small script unpacks their libraries into
`blender/lib`. The daemon sets `LD_LIBRARY_PATH` for the Blender child only, because `RUNPATH`
does not reach `libGL`'s own dependencies.

**The daemon owns export, not the worker.** The worker owns generation, and its intake is still
open to local callers (`vili-worker-intake-local-callers`). If export ran in the worker, that open
intake would grow by a converter and a new output path. In the daemon, the FBX path comes from the
job id. The BVH inputs are the worker's listed files, but only those that resolve to regular files
inside the job's artifact directory. Blender runs in its own process group. The daemon calls
`guard()` immediately before each spawn and each write. A lease loss SIGKILLs the group, and SIGTERM
stops it, exactly as for the worker. So **closing the worker's intake is not a dependency** of this
cut: export adds no caller-chosen path and no new intake. The fix stays the next Vili cut on its own
merits.

**Provenance is the job record, not a second file.** r2 put a provenance block into Kimodo's
`meta.json`. That made a Kimodo input file carry keys Kimodo does not know, and it duplicated what the
job record already holds: the request, and the worker's model, encoder and Kimodo identity. r3 bumps
the job record to `motion_job.v1` and adds the seed used, an export block, and the sha256 of every
artifact file. The generate answer is that record, so a consumer that commits a clip
(`clips-committed`) saves the answer beside the FBX. The record is JSON until `vili-jobs-cultcache`.

**A read route, because a hand copy is a hand step.** Under Idunn the state root is `root:vili-state
2770`, and a caller on Starfire cannot read it without `sudo` on Yggdrasil. `GET
/motion/artifacts/<jobId>/<file>` serves one regular file from a job's artifact directory. Its names
are allowlisted (`motion.fbx`, `motion.bvh`, `motion/motion_NN.fbx|bvh`), and it serves no symlinks.
Reads take no lease. It is an API (`vili.motion.api`), not an operator surface, so
`surfaces-wait-for-thing2` does not hold it.

**The rest FBX is a job too.** r2 had a one-shot CLI mode. Under Idunn that means an `ssh`, a
`sudo` and the release's `node` by hand, and its output had no record. `POST /motion/rest-fbx`
converts the release's own Kimodo `somaskel77_standard_tpose.bvh` through the same script. It runs
under the same write gate, writes a job record, and is read back by the same route. That makes
it the avatar cut's source.

**The seed is always recorded.** A request without a seed used to reach Kimodo unseeded and leave
no seed in the record, so no artifact could be reproduced. The daemon now mints one
(`crypto.randomInt(0, 2**31)`) and records it for every job, FBX or not
(`artifact-provenance`).

### Earlier decisions

- **Blender stays; the FBX SDK does not come in.** Skipping Blender would save
  a 3 to 8 s CPU step against a generation measured in minutes, and a portable
  install the operator already approved. It would cost a proprietary dependency
  reached only through `fbxsdkpy`, an unofficial repackaging of the Autodesk FBX
  SDK 2020.1 on Inria's GitLab index with wheels up to Python 3.10, pinned
  beside Kimodo's own environment. Every community FBX-SDK writer also renames to
  Mixamo and retargets onto a user rig, which is the engine's job here. Writing
  our own SDK writer would make Vili a second producer of joint rotations beside
  Kimodo's BVH writer, the place upstream issue #43 shows Euler conversion bugs
  live. So Blender is still needed. On Yggdrasil it is the pinned Linux 5.2.2 tarball
  (`vili-moves-to-yggdrasil-now`), in `cut-vili-fbx-export` r3.
- **SOMA names, not Mixamo names** (`motion-pipeline:ruling:skeleton-names-soma`).
  Mixamo names help only a consumer that auto-maps by name. StreamPixels commits
  its table, Unreal IK Rig and Godot take any names, and renaming in Vili would
  drop joints Mixamo lacks and put a per-target mapping where the target forbids
  one.
- **The SOMA table is code, the `.meta` is derived.** r1 had an uncommitted
  one-off method write the `.meta`, which left the committed avatar's owner
  outside the repo. The probe showed the table cannot be applied by a preprocess
  hook alone, so a committed editor method applies it and a test pins the `.meta`
  to the table.

## Cuts not yet mapped

`cut-vili-admission` is merged (`c5cf445`), and `cut-vili-fbx-export` r3 is mapped (its spec is in
the mind). One line each for the rest:

- **Raven teardown** (the list under "What retires on Raven"), and Self supersedes the Raven
  rulings with it. Waits on nothing now that admission is live.
- **`cut-soma-humanoid-avatar` r3**, its rest FBX taken from `POST /motion/rest-fbx` on Yggdrasil
  instead of Raven. Waits on the FBX cut.
- **RPS slot clips** (`motion-pipeline:follow_up:rps-slot-clips-from-vili`; Winner and Loser travel,
  `rps:ruling:rps-duelists-exit-celebrating-moping`). Waits on the avatar cut.
- **Vili intake closed** (`motion-pipeline:follow_up:vili-worker-intake-local-callers` and
  `vili-caller-read-paths-2`). Independent of the FBX cut.
- **Vili publishes to Odin over CultMesh**, as StreamPixels' service does. Waits on nothing.
