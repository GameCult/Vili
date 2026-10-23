# Motion pipeline map

The prose half of campaign `motion-pipeline`. Questions, rulings, cut specs,
reports, verdicts and findings are typed documents in the eureka mind; this page
keeps only what no kind carries: body facts, the model page, rationale and the
cuts not yet mapped. The target's rationale is `docs/motion-pipeline-target.md`.

## Body facts

### Raven GPU tenancy probes, 2026-10-22 20:15 to 20:23 UTC

Run read-only from Starfire over `ssh -o HostName=192.168.178.165 raven`
(alias in `~/.ssh/config`; LAN address per `gamecult-ops/inventory.md`), as
`powershell -NoProfile -NonInteractive -EncodedCommand`. Nothing on Raven was
changed: no task edits, no restarts, no GPU jobs. Program names were not
collected; where a process had to be classified, the probe printed only a
category (compositor, WSL family, or "other").

| Probe | Result |
|---|---|
| Session of the Vili daemon | `node.exe ... vili-daemon.mjs --host 0.0.0.0 --port 8824` runs in **session 1**, the console session of `madman's lullaby` (`query user`: console, ID 1, Active). It is the interactive desktop session, not session 0. |
| Vili task principal | `\GameCult\Vili`: `LogonType Interactive`, `RunLevel Limited`, boot trigger (`MSFT_TaskBootTrigger`), last run 2026-10-22 21:18:55 local, result 0. Children the daemon spawns inherit session 1. |
| SSH context | Windows `sshd` runs commands in **session 0**, elevated (`IsInRole(Administrator)` true). `gamecult-ops/runbooks/idunn-host-raven.md` already records that sshd cannot start anything in the user's session without a scheduled-task hop. |
| `SHQueryUserNotificationState` from session 0 | `hr=0`, state `2` (`QUNS_BUSY`) on every call, with the GPU idle (3D engine total 0.01 to 0.02 %). Session 0 has no shell, so this value says nothing about the user's desktop. The call must run in session 1, which is where the daemon and its children are. It was **not** observed from session 1: doing that without a task edit is impossible from SSH. |
| `nvidia-smi.exe` | Present at `C:\WINDOWS\system32\nvidia-smi.exe`. `--query-gpu=memory.total,memory.used,memory.free,utilization.gpu`: `16380, 1592, 14516, 2` MiB/%. 63 ms cold, about 49 ms per call (10 calls 491 ms). Per-process `--query-compute-apps` returns `[N/A]` memory under WDDM. |
| `\GPU Engine(*engtype_3D)\Utilization Percentage` | Readable from session 0 as admin; 115 instances. `Get-Counter -SampleInterval 1 -MaxSamples 1` takes 1.08 s wall, 16 ms CPU warm, 328 ms CPU on first use in a process. Summed with `Measure-Object` it needs no instance names. Not tried as a Limited token in session 1. |
| `\GPU Adapter Memory(*)\Dedicated Usage` | Readable; 1.0 s wall; 1597 MiB on the RTX 4060 Ti, 0 on the Parsec virtual adapter. |
| `\GPU Process Memory(*)\Dedicated Usage` | Readable; 1.0 s wall. Two instances above 50 MiB: the desktop compositor (1643 MiB, session 1) and one session-0 process outside the WSL family (1405 MiB). Per-process figures overlap: they sum above the adapter total. |
| WSL attribution | The Kimodo worker container was resident (`/health` ok, uptime 3454 s, 6 generations) while `vmmemWSL` (and `vmwp`) had **no** `GPU Process Memory` instance. Host counters do not attribute WSL CUDA memory to a nameable host process. WSL `nvidia-smi` reported the same `1592 MiB used, 14516 MiB free` as the host. |
| PowerShell cost | `powershell.exe` 5.1 cold start 266 ms CPU, `Add-Type` for the shell32 call 78 ms CPU, first counter read 328 ms CPU: about 0.7 s CPU per cold spawn. A warm loop iteration (QUNS + `nvidia-smi` + one 3D counter read) is about 1.1 s wall and 16 ms of its own CPU. |
| Adapters | `NVIDIA GeForce RTX 4060 Ti` driver 32.0.16.1088, 16 GiB; `Parsec Virtual Display Adapter`. |

What follows from these, and what does not:

- The daemon's own session sees the user's desktop, so the tenancy probe runs as
  a child of the daemon. No fork about where it runs: the scheduled task already
  puts it in the right session.
- Free VRAM must come from the host (`nvidia-smi.exe`), not from torch in WSL:
  Soul's s1 probe on cut `vili-encoder-placement` showed `mem_get_info` inside a
  container blind to another container's 12 GiB. Whether host `nvidia-smi` sees
  a WSL container's allocation is **unverified** (the resident worker's share
  could not be separated from the compositor's); the gate cut checks it first.
- The 3D-engine signal cannot be used to tell Vili's own work from the
  household's by process, and need not be: Kimodo runs on CUDA (compute
  engines), games on the 3D engine. Summing only `engtype_3D` leaves Vili out.
- A long-lived probe child costs about 1 ms of CPU per second at a 15 s period;
  a fresh PowerShell per sample would cost about 45 ms per second. Neither
  loads the GPU.

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

| Kind | Named by | Over time | Decided by |
|---|---|---|---|
| GPU tenancy state (`gpu` in `gamecult.vili.operator_state.v1`) | the daemon, one per host | rewritten every 5 s with the operator state; holds `inUse`, `since`, `checkedAt`, `probeOk` and nothing else | the daemon's tenancy gate, from host samples; never persisted as truth, rebuilt from samples at start |
| Motion job (`.vili/jobs/<jobId>.json`) | `vili-<epoch ms>` | written once when a job ends | the daemon; a job refused at admission writes none |
| Text embedding (`.vili/embeddings/text-embeddings.cc`) | `sha256(identity, text)` | append on miss | the worker's cache |
| Clip artifact (`.vili/artifacts/<jobId>/motion*.bvh`, `motion*.fbx`, `meta.json` provenance) | the job id; `clipName` inside the FBX | written once per job; the BVH is the reproducibility unit, the FBX is derived | the daemon (export) from Kimodo's BVH; planned by `cut-vili-fbx-export` |
| SOMA Humanoid table (StreamPixels `Assets/Editor/Motion/SomaHumanoid.cs`) | SOMA77 joint names to `HumanBodyBones` | changes only by code edit, then `ApplyToRest` rewrites the rest FBX's `.meta` | the engine; planned by `cut-soma-humanoid-avatar` |

## Rationale

- **Refuse, do not queue (recommended, pending the operator).** `/motion/generate`
  is synchronous today. Holding a request open for as long as a game runs, or
  adding a persisted job queue, are bigger machines than the one consumer needs:
  RPS clip generation is a script an agent runs, and it can retry a typed
  `gpu-busy`. A queue belongs with the authoring UX's takes, when that target
  exists (`motion-pipeline:follow_up:vili-authoring-ux-target-2`).
- **Fail closed.** If the probe child dies or stops answering, the gate reports
  in use. A wrongly deferred clip costs minutes; a wrongly admitted encoder child
  pages a game's VRAM and thrashes Raven.
- **The child's own VRAM check is placement, not tenancy.** `plan_placement`
  still sizes accelerate's `max_memory` from torch's view and can still refuse;
  it answers "can the encoder be placed", not "may heavy work start".

- **Blender stays; the FBX SDK does not come in.** Skipping Blender would save
  a 3 to 8 s CPU step against a generation measured in minutes, and a portable
  install the operator already approved. It would cost a proprietary dependency
  reached only through `fbxsdkpy`, an unofficial repackaging of the Autodesk FBX
  SDK 2020.1 on Inria's GitLab index with wheels up to Python 3.10, pinned
  beside Kimodo's own environment. Every community FBX-SDK writer also renames to
  Mixamo and retargets onto a user rig, which is the engine's job here. Writing
  our own SDK writer would make Vili a second producer of joint rotations beside
  Kimodo's BVH writer, the place upstream issue #43 shows Euler conversion bugs
  live. So Blender is still needed, and its download (ruling
  `blender-body-portable`) is still owed; `cut-vili-fbx-export` r2 does it.
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

- RPS beats through Vili (`motion-pipeline:follow_up:rps-clips-from-vili`), after
  the gate and `vili-fbx-export`.
