# Vili on Yggdrasil CPU, 2026-10-23

Directed by `motion-pipeline:ruling:jobs-on-yggdrasil-if-cpu-works` (measure first, then
move). Measured by imagination-vili-ygg, session sp-reentry-2026-10-21. It follows
`docs/research/kimodo-cpp-probe-2026-10.md` (4a4c8ea), whose assemblies A and B it reuses:

- **A** is Kimodo 6bb5848's own `LLM2VecEncoder`, the path Vili's loader mirrors today. Under
  transformers 5.1.0 the MNTP adapter is not applied: the LOAD REPORT shows the 32 layers' LoRA keys
  UNEXPECTED and MISSING again in this run. A reproduces Vili's stored vectors at cosine 0.99997.
- **B** is the Llama base, the MNTP adapter merged explicitly with `PeftModel`, then the
  supervised adapter. This is LLM2Vec's design.

Raven was not touched.

## Headline

| what (Yggdrasil CPU, torch 2.5.1, 8 threads, other agents' load 10 to 12) | result |
|---|---|
| Kimodo torch denoiser, 2 s clip (60 frames), 20 steps, post-processing on, 77-joint SOMA BVH, cached vector | **12 to 15 s** (v1.1 13.2 to 13.4 s; v1.2 11.9 to 14.7 s) |
| the same, 3 s clip (90 frames) | 15 to 17.5 s |
| post-processing's share | negligible: without it a 2 s clip takes 12.5 to 13.7 s |
| denoiser worker process | 2.5 GiB peak RSS; model load 0.8 to 2.6 s on a warm page cache, plus 3 s of imports |
| torch B encoder child (cache miss), bf16 CPU | 55 s cold process (34 s load, then 4 to 6 s per prompt); **14.3 GiB peak** |
| torch A encoder child, bf16 CPU | 93 s cold process (73 s load, 2 to 8 s per prompt); 14.3 GiB peak |
| kimodo.cpp Q8_0 encoder child (cache miss) | 8.5 to 15 s cold process, 4.1 to 10.4 s per encode; about 1.9 GiB RSS |
| same seed, same request, rerun | bit-identical joints (0.0 mm max) on v1.1 and v1.2 |

So a cache-hit clip costs about 13 s on Yggdrasil, against about 2 s on Raven's GPU
(`cut-vili-encoder-placement.s1`). That is about 6.5 s per second of motion, where June on Raven
cost about 54 s (`motion-pipeline:follow_up:raven-host-ram-ceiling`). A cache miss adds one encoder
child: 55 s with torch B. On Raven a miss cost 61 s on the GPU and 428 s on its CPU.

## Vectors and clips against assembly B

Prompts (`prompts.json` in the scratch, seed 7, Kimodo-SOMA-RP-v1.1, 3 s, post-processing on):

- **rock:** "A person shakes their fist up and down three times, then thrusts a closed fist forward like a rock."
- **paper:** "A person shakes their fist up and down three times, then thrusts an open flat hand forward, palm down, like paper."
- **victory:** "A person does a joyful victory dance, hopping and pumping both fists in the air."

| | rock | paper | victory |
|---|---|---|---|
| cosine Q8 vs B | 0.99976 | 0.99981 | 0.99978 |
| cosine A vs B | 0.90942 | 0.94157 | 0.93504 |
| vector norm A / B / Q8 | 133.0 / 128.4 / 128.4 | 129.7 / 126.9 / 127.1 | 133.2 / 125.1 / 125.2 |
| posed joints, Q8 vs B, mean / max mm | 16.5 / 75.4 | 7.8 / 31.2 | 26.2 / 49.9 |
| posed joints, A vs B, mean / max mm | 162.2 / 1015.2 | 32.0 / 215.4 | 53.1 / 304.1 |
| v1.2: A vs B, mean / max mm | 37.8 / 270.8 | 46.5 / 217.3 | 52.1 / 137.2 |

- **Q8 is not within the drift we accept.** GPU against CPU for the fist clip was 4.63 mm mean and
  54.28 mm max (`cut-vili-encoder-placement.s1`). Through Kimodo's own denoiser,
  post-processing and 77-joint output, Q8 lands at 2 to 6 times that mean, and rock's max is over
  it. Inside kimodo.cpp's sampler the probe had found 0.5 to 3 mm. The extra comes from
  Kimodo's pipeline amplifying a 0.9998-cosine vector change, not from the vector itself.
- **A and B are different motions**, on v1.1 and on v1.2. Rock under A against B moves up to 1 m.
- **v1.2 against v1.1** with the same vector and seed differs by 67 to 178 mm mean
  (`motion-pipeline:follow_up:kimodo-v1-2`). v1.2 costs the same CPU time.

## A/B eye check

The open question `motion-pipeline:question:encoder-mntp-and-ggml` is gated on this check.
`docs/research/assets/vili-ygg-cpu-2026-10/` holds six BVH files, about 206 KB each. They are
`v1.1_{A,B}_{rock,paper,victory}_3s.bvh`: Kimodo's own writer, SOMA77 names, standard T-pose
rest, centimetres, 30 fps, 90 frames. The folder also holds `view_ab.py`.

**View them on Starfire**, from a Vili checkout of this branch:

```
"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe" --factory-startup --python docs\research\assets\vili-ygg-cpu-2026-10\view_ab.py -- rock
```

1. Blender opens with A on the left (x -1 m) and B on the right (x +1 m), as stick skeletons, and
   plays both.
2. Repeat with `paper` and with `victory`.
3. For each prompt, judge which reads more like the prompt. Look at the countdown pumps, whether
   the thrust ends as a fist or as a flat hand, and whether the dance hops with both fists up.

The script ran headless on Starfire's Blender 5.2.2 and imported 78 bones per clip. Without the
script, any BVH viewer opens the files. In Blender, use File > Import > Motion Capture with scale
0.01, forward -Z and up Y. The hands carry the fist-or-flat difference, but stick bones show
finger joints only coarsely.

## Yggdrasil's capacity alongside its load

- **Body:** a Netcup KVM with 16 vCPU AMD EPYC-Genoa (AVX-512 with BF16 and VNNI), one NUMA
  node, 62 GiB RAM and about 7 GiB swap. The disk is 2 TB with 1.3 TB free. It runs Debian 13.
- **Resident load:** Huginn, Idunn (odin, streampixels-service and streampixels-web), Bifrost
  and its persona services, Forgejo (with Eureka's runner), Heimdall, Postgres, Redis, VoidBot
  retrieval (Qdrant and MCP), repixelizer-gui and nginx. They use about 7 to 10 GiB, with 52
  to 55 GiB available.
- **The verify stopgap dominates the CPU.** During this pass three `eureka-verify-*` containers
  ran beside rustc and dotnet. Each is capped at 4 CPUs and 6 to 12 GiB, at nice 10, the same
  nice as these runs. The load average moved from 6 to 40 on 16 cores.
- **Thread count decides the timing under that load, not core count.** The first runs used 16
  threads at a load of 17 to 40:
  - the torch encode took 115 to 143 s per prompt, against 2 to 8 s at 8 threads;
  - the Q8 encode took 55 to 86 s, against 4 to 10 s;
  - the 2 s clip took 18 to 81 s, against 12 to 15 s.

  OpenMP and GGML workers that spin at barriers fall apart when the host is oversubscribed. A
  Vili worker on Yggdrasil must cap its threads well below 16: 8 is measured, and fewer may be
  better under heavier verify load.
- **Memory is not the constraint.** At most 2.5 GiB is resident, plus a 14.3 GiB encoder child
  for about a minute per miss. That fits beside everything, with the verify stopgap's caps
  included. A busy verify burst costs Vili time, not correctness.

## What Vili becomes on Yggdrasil (map, not a cut)

- **Today's body on Raven:**
  - the `\GameCult\Vili` scheduled task runs Node `vili-daemon.mjs` on `10.77.0.4:8824`;
  - the daemon reaches the resident worker through `wsl.exe -d Ubuntu-24.04 ... docker`, as a
    container on `:8825`;
  - a transient encoder child runs on the GPU;
  - the state lives in `F:\Projects\Vili\.vili` (jobs, artifacts, the
    `text-embeddings.cc` cache);
  - the unmerged tray toggle (`cut-raven-gpu-tenancy-gate` r2, branch head a3052dd) is the
    household's GPU permission.
- **Target body on Yggdrasil:** one Idunn `systemd-transient` target with no GPU, no WSL, no
  Docker at runtime and no tray toggle.
  - The daemon owns the worker as a child process: `python kimodo-resident-worker.py`,
    `device=cpu`, threads capped. The encoder stays a transient child per miss.
  - Idunn has no container or Python workload kind; its workloads are `systemd-transient` and
    `host-actuator` (Idunn `src/deployment.rs:446-467`). Its migration doc names the Python gap:
    "a wheel, or a venv materialized into the release root" (`docs/migration.md:283-293`).
  - The nearest precedent is CodexConnector. It ships a pinned external binary as an adjacent
    artifact with `expected_sha256` (`deployment/idunn/recipe.toml:6-18, 47-73`).
  - So the recommended shape is a recipe whose build step, in a docker runner pinned by digest,
    materializes a locked venv into the release. That venv holds torch 2.5.1 CPU,
    transformers 5.1.0, peft 0.18.1, Kimodo at its pin, MotionCorrection and SOMA-X.
  - The Node binary and the daemon ship as StreamPixels' do.
- **State and artifacts:**
  - `/var/lib/gamecult/vili` holds jobs, artifacts and `embeddings/text-embeddings.cc`, as an
    Idunn state slot.
  - Weights (about 18 GiB: the Llama base, the two McGill adapters and the SOMA-RP checkpoints)
    go in a host-provisioned read-only directory, `/srv/vili/models` as an HF hub layout. Idunn
    mounts it with `read_only_paths`, as it mounts `/srv/streampixels/content`, and the worker
    checks its sha256 manifest at start.
  - The embedding cache carries over from Raven. Its identity must name assembly and placement
    first (`motion-pipeline:follow_up:embedding-identity-complete`), so CPU B vectors never
    alias GPU A vectors.
- **Raven, under the Loud Rebuild Contract:**
  - In the same cut that admits Vili on Yggdrasil, delete the Windows scheduled task, its
    launchers (`install-vili-task.ps1`, `start-vili-daemon.ps1`, `run-vili-daemon.ps1`,
    `restart-vili-daemon.*`, `run-hidden-powershell.vbs`, `health-vili-daemon.cmd`), the
    `wsl()`/docker worker path and the `10.77.0.4` addresses in `vili-daemon.mjs`.
  - The worker container and its image on Raven's WSL are removed on Raven, not in the repo.
  - The tray toggle (`vili-gpu-tray.ps1`, `install-vili-tray-task.ps1`, `gpu-tenancy.mjs` and
    its tests) has nothing to gate on a GPU-less host. Its branch should not merge. Its spec and
    the rulings `raven-gpu-tray-toggle`, `raven-gpu-defers-to-household`, `gpu-defer-refuse-typed`
    and `vili-idunn-deferred` are superseded by the move.
  - `raven-host-ram-ceiling` becomes moot.
  - Raven keeps its GPU for the household and no Vili code path. If the GPU is ever wanted
    again, that is a new campaign question, not a dormant branch.
- **Blender FBX export (`cut-vili-fbx-export` r2)** is a 3 to 8 s CPU step headless
  (`-b --factory-startup`). Nothing in it is Windows-only except the pinned path.
  - On Yggdrasil it takes Blender 5.2.2 LTS linux-x64 from download.blender.org, pinned by
    sha256, as an Idunn `external_input` or under `/srv/vili/tools`. The operator's approval
    (`blender-body-portable`) names the Windows zip on Raven, so the Linux tarball is a new
    approval.
  - Headless Linux Blender is unverified here: nothing was downloaded. It typically needs
    `libxi6`, `libxkbcommon0`, `libsm6`, `libxrender1` and `libgl1` even with `-b`.
  - The spec's dependency on `raven-gpu-tenancy-gate` falls away. Its base becomes the move cut.

## Method and custody

- **Images and checkouts:**
  - Image `vili-cpu-probe:1` is python:3.12 with torch 2.5.1+cpu, Kimodo's pins (transformers
    5.1.0, peft 0.18.1, accelerate 1.13.0, numpy 1.26.4, hydra 1.3.2), SOMA-X from git and
    MotionCorrection from Kimodo 6bb5848.
  - Kimodo 6bb5848 ran v1.1; a worktree at e1c219c ran v1.2. Checkpoints:
    `nvidia/Kimodo-SOMA-RP-v1.1@6c9233af` and `-v1.2@0e3c8902`.
- **Run caps:** every run went in its own `--rm` container capped at 16 CPUs and 40 GiB, at
  `nice 10`, one at a time.
- **Shared-cache scar.** The shared probe cache `~/scratch/kimodo-cpp-probe/hf` was being
  rewritten during this pass by another agent's throttled tar stream: PIDs 647522 and 649758,
  started about 00:10 UTC, at 1.2 MB/s. Llama shard 1 stood at 1.0 to 1.4 GB of 4.98 GB.
  These runs therefore used a private cache, `~/scratch/vili-ygg-cpu/hf2`. Its four shards were
  fetched from the ungated mirror NousResearch/Meta-Llama-3-8B-Instruct and match Raven's
  sha256 prefixes `d8cf9c4d`, `8d4782b4`, `3acdd690` and `67e9ad31`. Those PIDs were left alone.
- **Scratch:** `~/scratch/vili-ygg-cpu` holds the scripts, logs (`run*.log`, `out/*.log`),
  vectors, joints and BVH files, plus 18 GiB of weights. Delete it once nobody reruns this.
  All its containers are removed.

**Correction, 2026-10-23.** The "MNTP missing" diagnosis in this document is wrong. The MNTP adapter is applied in both loads (the cut measured a q_proj difference of 0.0117 for repo ids and snapshot paths alike). What separates A from B is the Llama-3 chat header: Kimodo's `LLM2Vec.prepare_for_tokenization` wraps the text in it only when the model's `_name_or_path` is the repo id `meta-llama/Meta-Llama-3-8B-Instruct`, which a load from a snapshot path silently drops (`motion-pipeline:finding:cut-vili-cpu-body.s1.ab-premise-inverted`). B's weights with the bare header give cosine 0.9977 to A, and without it 1.0 to B; the header plus LLM2Vec's instruction marker, which keeps the header out of the pooling as Kimodo's encode path does, gives 1.0 to A (checked 2026-10-23). Vili now applies the header explicitly (`motion-pipeline:ruling:encoder-chat-header-on`). The measurements above stand as measured; read "MNTP" in the A/B account as "the chat header".
