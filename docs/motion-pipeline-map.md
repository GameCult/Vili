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

## Model page

| Kind | Named by | Over time | Decided by |
|---|---|---|---|
| GPU tenancy state (`gpu` in `gamecult.vili.operator_state.v1`) | the daemon, one per host | rewritten every 5 s with the operator state; holds `inUse`, `since`, `checkedAt`, `probeOk` and nothing else | the daemon's tenancy gate, from host samples; never persisted as truth, rebuilt from samples at start |
| Motion job (`.vili/jobs/<jobId>.json`) | `vili-<epoch ms>` | written once when a job ends | the daemon; a job refused at admission writes none |
| Text embedding (`.vili/embeddings/text-embeddings.cc`) | `sha256(identity, text)` | append on miss | the worker's cache |

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

## Cuts not yet mapped

- RPS beats through Vili (`motion-pipeline:follow_up:rps-clips-from-vili`), after
  the gate and `vili-fbx-export`.
