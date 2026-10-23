# Motion pipeline map

The prose half of campaign `motion-pipeline`. Questions, rulings, cut specs,
reports, verdicts and findings are typed documents in the eureka mind; this page
keeps only what no kind carries: body facts, the model page, rationale and the
cuts not yet mapped. The target's rationale is `docs/motion-pipeline-target.md`.

## Body facts

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
| Clip artifact (`<state>/artifacts/<jobId>/motion*.bvh`, `motion*.fbx`, `meta.json`) | the job id; `clipName` inside the FBX | written once per job; the BVH is the reproducibility unit, the FBX is derived | the daemon (export) from Kimodo's BVH; FBX planned by `cut-vili-fbx-export` |
| Model weights (`<models>`, Hugging Face hub layout, with a sha256 manifest) | repo id and snapshot revision | provisioned by agents on the host; read-only to Vili; changed only by a new manifest | host provisioning; from the admission cut the worker refuses to start when the manifest does not match |
| Worker environment (CPython 3.12 plus the locked site-packages) | the lock file's sha256 | rebuilt by the Idunn recipe on each release, sealed read-only | the recipe; question `motion-pipeline:question:worker-python-interpreter` decides where the interpreter comes from |
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
  the interpreter. Headless Linux Blender's shared libraries (`libxi6`, `libxkbcommon0`,
  `libsm6`, `libxrender1`, `libgl1`) are host packages; the FBX cut probes them first.

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

**Why the interpreter must travel, and what Idunn owes.** A venv points at its base interpreter
by absolute path, and Yggdrasil's own Python is 3.13, which Kimodo's numpy pin cannot use. So the
release carries a relocatable CPython 3.12 whose `bin/python3.12` must be executable. Idunn seals
every file inside a tree artifact 0444 and allows only single-filename destinations, so today no
recipe can ship it. That is follow-up `motion-pipeline:follow_up:idunn-tree-executable-members`.
The admission cut waits on it; `cut-vili-cpu-body` does not.

**Why the embedding cache starts empty.** Raven's file holds assembly A vectors made on the GPU.
Under the complete identity none of them can ever hit, and carrying inert rows forward would only
make the file lie about what it holds. A miss costs 55 s once per prompt.

**Why Raven is retired at admission, not before.** The ruling says the old host decides nothing
after the cut-over. `cut-vili-cpu-body` removes every Raven path from main, so no new Raven body
can be made from main. The running Raven daemon is a detached checkout of the unmerged gate
branch with no caller, and it is torn down in the same session that admits Vili on Yggdrasil, so
Vili is never without a host while Idunn's contract is pending.

**What retires on Raven, in the admission session.** The `\GameCult\Vili` and `\GameCult\ViliTray`
tasks are stopped and unregistered (PIDs 31324 and 4540 at probe time); the WSL keepalive loop is
killed; container `vili-kimodo-worker`, image `gamecult/kimodo:latest`, image
`nvidia/cuda:12.4.1-base-ubuntu22.04`, `/opt/gamecult/kimodo` and `/root/.cache/huggingface` (17 GB,
Vili's repos only) are removed once Yggdrasil's `/srv/vili/models` manifest matches; `.vili` and
`/opt/gamecult/kimodo-runs` are archived to `/srv/retired/vili-raven-2026-10/` on Yggdrasil with
their sha256 recorded, then deleted with the `E:\Projects\Vili` checkout. `nvidia/cuda:12.6.3-devel`
stays until its owner is proven. The `cut/raven-gpu-tenancy-gate` branch is not merged; its
cross-site refusal is ported, the rest dies with it.

**Rulings the move overturns, for Self to supersede.** `raven-gpu-tray-toggle`,
`raven-gpu-defers-to-household`, `gpu-defer-refuse-typed`, `vili-idunn-deferred`,
`encoder-transient-gpu` and `blender-body-portable` (its Windows zip on Raven). The gate spec
`cut-raven-gpu-tenancy-gate.r2` is withdrawn, and the follow-ups `raven-gate-residue`,
`raven-gpu-tenancy-gate` and `raven-host-ram-ceiling` are moot. `cut-vili-fbx-export.r2` and
`cut-soma-humanoid-avatar.r2` were mapped against Raven; each gets a fresh revision after the
admission cut, not an edit now.

**Eve leaves with the move.** The daemon's Eve surface, deck WebSocket and Eve-schema provider
advertisement are quarantined at tag `parked/vili-eve-surface` (`thing2:ruling:eve-dashboards-quarantined-2`,
the Vili item of `thing2:follow_up:eve-quarantine-remainder`). They named `asgard.raven.vili`, so
the move would have had to rewrite them anyway.

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

`cut-vili-cpu-body` is mapped (its spec is in the mind). After it, in order:

- **Vili admitted on Yggdrasil, Raven retired.** `deployment/idunn/vili.toml` (vendor/CultLib
  gitlink, python-build runner, the interpreter and Kimodo, SOMA-X and MotionCorrection as
  sha256-pinned `external_inputs`, a hash-locked `requirements.lock`, `.pyc` compiled
  `--invalidation-mode unchecked-hash`), an `idunn-entry.mjs` answering
  `gamecult.runtime_presence_health.v2` through `cultnet-ts/idunn-runtime`, the operator binding
  and runtime identity, `/srv/vili/models` provisioned from `~/scratch/vili-ygg-cpu/hf2` with a
  sha256 manifest, the state slots and write lease (jobs into CultCache here, or a line of its
  own), then the Raven teardown above in the same session, and gamecult-ops `inventory.md`
  repointed by its owner. Waits on `cut-vili-cpu-body`, on
  `motion-pipeline:follow_up:idunn-tree-executable-members` and on
  `motion-pipeline:question:worker-python-interpreter`.
- **Vili publishes to Odin over CultMesh**, as StreamPixels' service does. Waits on admission.
- **`cut-vili-fbx-export` r3**, re-mapped onto the Yggdrasil body: Linux Blender 5.2.2 in the
  release under the same Idunn contract, no gate dependency, provenance from the new worker
  identity. Waits on admission.
- **`cut-soma-humanoid-avatar` r3**, sources copied from Yggdrasil instead of Raven. Waits on
  the FBX cut.
- **RPS beats through Vili** (`motion-pipeline:follow_up:rps-clips-from-vili`) on Yggdrasil, with
  the countdown content `rps:ruling:countdown-clip-is-fist-into-palm` and
  `rps:ruling:countdown-three-hits-reveal-on-third`. Waits on both r3 cuts.
