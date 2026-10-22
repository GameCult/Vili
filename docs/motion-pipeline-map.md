# Motion pipeline map

The prose half of campaign `motion-pipeline`. Questions, rulings, cut specs,
reports, verdicts and findings are typed documents in the eureka mind; this page
keeps only what no kind carries: body facts, the model page, rationale and the
cuts not yet mapped. The target's rationale is `docs/motion-pipeline-target.md`.

## Body facts

### Raven tray-toggle probes, 2026-10-22 23:30 to 23:36 UTC

Run read-only from Starfire over `ssh raven` (session 0, elevated), one
PowerShell 5.1 script copied to `C:\Users\Public` and deleted in the same
command. Nothing on Raven was changed: no task edits, no restarts, no GPU jobs.
They inform cut spec `motion-pipeline:cut_spec:cut-raven-gpu-tenancy-gate.r2`,
which replaces detection with the household's toggle
(`motion-pipeline:ruling:raven-gpu-tray-toggle`).

| Probe | Result |
|---|---|
| Who the household is on Raven | One account. `query user`: `madman's lullaby`, console, session 1, Active since 2026-10-18. The `\GameCult\Vili` task runs as that same user (`LogonType Interactive`, `RunLevel Limited`), so a tray process at that user's logon is in the same session and the same user as the daemon, with no admin rights. |
| Daemon listen address | `node.exe ... vili-daemon.mjs --host 0.0.0.0 --port 8824 --state-root E:\Projects\Vili\.vili`, pid 33776, session 1, at detached head `a2b9983`. Listens on `0.0.0.0:8824`, so the WireGuard peers can reach every route; a write route must check the caller itself. `GET http://127.0.0.1:8824/operator-state` from Raven answers in 3 ms. |
| Live task action versus the installer | The live `\GameCult\Vili` action passes `-IdunnRudpHealth 10.77.0.2:17870 -IdunnDaemon vili -IdunnHealthContract ... -IdunnHealthIntervalSeconds 15` to `start-vili-daemon.ps1`; `scripts/install-vili-task.ps1` does not. Rerunning that installer would rewrite the live task, so the tray gets its own installer. |
| Tray substrate | `powershell.exe` 5.1.26100, apartment `STA` by default; `System.Windows.Forms` and `System.Drawing` load (`v4.0.30319`, .NET Framework release 534296). Execution policy is Undefined at every scope (the task launcher passes `-ExecutionPolicy Bypass`). `scripts/run-hidden-powershell.vbs` already starts a hidden PowerShell with no console flash. No new dependency is needed. |
| Tray overflow | `HKCU:\Control Panel\NotifyIconSettings` exists with 47 entries: Windows 11 records each notify icon there and puts new ones in the overflow until the user promotes it. A fresh tray icon will not be on the taskbar until the household drags it there once (or turns it on under Settings, Personalization, Taskbar, Other system tray icons). |
| Startup folder | `C:\Users\Madman's Lullaby\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`. Not used: from SSH (session 0) nothing in it can be started in session 1, while `Start-ScheduledTask` on an Interactive task can. |
| Scheduled tasks under `\GameCult\` | `Backup-Yggdrasil-Pull`, `ComfyUI`, `Vili`, all Ready. ComfyUI is a second possible heavy GPU consumer on Raven; the toggle governs Vili only. |
| Host free VRAM | `C:\WINDOWS\system32\nvidia-smi.exe --query-gpu=memory.free --format=csv,noheader,nounits`: 159 ms from a cold PowerShell, exit 0, free 5001 MiB at 23:3x UTC (the household or another consumer held about 11 GiB). No `nvidia-smi.exe` process was left running. |
| Vili's store | `E:\Projects\Vili\.vili\vili.service.cc`, 11810 bytes. Newest job file `vili-1792710792764.json`, written 23:20:12 UTC. The live gate (`a2b9983`) read `inUse true, probeOk true`. |
| cultcache-ts on Raven | `E:\Projects\CultLib` at `b9497d35`, package `0.14.1`; its build carries `pullAllBackingStores`. `SingleFileMessagePackBackingStore.push` reads the file, replaces one `(type, key)` entry and writes all, inside a write queue that belongs to one store instance. |

### Raven GPU tenancy probes, 2026-10-22 20:15 to 20:23 UTC

These informed r1's detection gate, which r2 deletes. The session, principal and
`nvidia-smi` rows still hold.

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
| `SHQueryUserNotificationState` from session 0 | `hr=0`, state `2` (`QUNS_BUSY`) on every call, with the GPU idle. Session 0 has no shell, so this value says nothing about the user's desktop. |
| `nvidia-smi.exe` | Present at `C:\WINDOWS\system32\nvidia-smi.exe`. `--query-gpu=memory.total,memory.used,memory.free,utilization.gpu`: `16380, 1592, 14516, 2` MiB/%. 63 ms cold, about 49 ms per call. Per-process `--query-compute-apps` returns `[N/A]` memory under WDDM. |
| `\GPU Engine(*engtype_3D)\Utilization Percentage` | Readable from session 0 as admin; 115 instances; `Get-Counter` 1.08 s wall. |
| `\GPU Process Memory(*)\Dedicated Usage` | Per-process figures overlap and sum above the adapter total. |
| WSL attribution | Host counters do not attribute WSL CUDA memory to a nameable host process. Host `nvidia-smi.exe` does see a WSL container's allocation: cut report h1 measured free falling 14292 to 1866 MiB under a 12 GiB holder. |
| Adapters | `NVIDIA GeForce RTX 4060 Ti` driver 32.0.16.1088, 16 GiB; `Parsec Virtual Display Adapter`. |

### What the detection gate taught (r1, h1, h2, s1, s2)

- Host free VRAM cannot tell Vili's encoder child from a household load: the
  child sizes itself to the VRAM that was free (s1 `self-tenancy-refusal`).
  Discounting Vili's own VRAM during a job blinds the gate to a household load
  that starts mid-job (s2 `hold-blinds-household-vram`).
- Live, the probe child went silent during 2 of 5 of Vili's own encoder jobs and
  the gate stayed stale after the job (s2 `own-load-starves-probe`; Raven had
  770 MB of host RAM available at one stall). Every repair added a watchdog, a
  drain or a baseline, and each brought its own finding.
- After a job ends, host free VRAM is back at 14.6 to 15.2 GiB at the next
  2-second sample (s2), so one `nvidia-smi` read before a job, with no job
  holding the slot, sees the card as the household left it.

## Model page

| Kind | Named by | Over time | Decided by |
|---|---|---|---|
| GPU permission (`gamecult.vili.gpu_permission.v1` in `.vili/vili.service.cc`, key `raven`) | the daemon, one per host | written only when the household changes it, before the change is acknowledged; read once at daemon start; absent means not allowed | the household, through the tray, through the daemon's loopback-only `POST /gpu-permission`; the daemon is its one writer |
| GPU status (`gpu` in `gamecult.vili.operator_state.v1`) | the daemon | rewritten every 5 s with the operator state; `{ allowed, changedAt, jobRunning, lastRefusal }` | derived from the permission, the slot and the last refusal; display only, never read back |
| Motion job (`.vili/jobs/<jobId>.json`) | `vili-<epoch ms>` | written once when a job ends | the daemon; a job refused at admission writes none |
| Text embedding (`.vili/embeddings/text-embeddings.cc`) | `sha256(identity, text)` | append on miss | the worker's cache |

## Rationale

- **The household decides; nothing detects.** The operator replaced detection
  with a tray toggle (`motion-pipeline:ruling:raven-gpu-tray-toggle`). The
  detection gate's findings were the cost of guessing intent from counters; a
  yes from the person at the desk needs no guess, no hysteresis and no probe.
- **The daemon is the one owner of the permission; the tray is a lowering.**
  The tray reads and sets the state only through the daemon's HTTP route, so
  admission and the stored value cannot disagree and the tray holds no state of
  its own. The alternative, the tray writing a CultCache document the daemon
  reads, would give the document two writers on two clocks and make the daemon
  poll a file to learn its own admission rule.
- **Off on a fresh install, and off when the document is missing.** The safe
  default for the household: Vili does nothing on Raven's GPU until someone at
  the desk says yes. A stored yes survives restarts and reboots.
- **Loopback only for the write.** The daemon listens on `0.0.0.0`; the
  household's switch must not be flippable from a WireGuard peer. A request
  from a non-loopback address is refused 403. Agents read the state through
  `GET /gpu-permission` or `/operator-state` and never set it.
- **One cache instance for the daemon.** The 5-second surface writer built a
  new store per call. Two store instances writing one file each read, modify and
  write in their own queue, so a permission write could be lost under a
  concurrent surface write. One module-level cache serializes every write to
  `vili.service.cc`.
- **One slot, one fresh VRAM read, fail closed.** h2's slot stays: one job at a
  time, the rest refused at once with source `slot`. The slot is taken
  synchronously before the VRAM read, so two requests cannot both pass it. A
  failed or unparseable read refuses with source `vram`, so a job never starts
  onto a full card on a guess. The permission is checked again after the read.
- **Refuse, do not queue** (`motion-pipeline:ruling:gpu-defer-refuse-typed`).
  `/motion/generate` is synchronous; the consumer retries a typed `gpu-busy`
  after `retry-after`. A queue belongs with the authoring UX's takes
  (`motion-pipeline:follow_up:vili-authoring-ux-target-2`).
- **A logon task, not the Startup folder.** `Start-ScheduledTask` on an
  Interactive task puts the tray in the household's session from SSH at deploy
  time; a Startup folder entry would wait for the next logon. The task pattern
  matches `\GameCult\Vili`.
- **The privacy rule is moot.** "Never record program names" protected the
  household from a probe that watched its programs. With no probe, nothing in
  Vili observes the household's programs; the only household fact Vili holds is
  the yes or no the household chose.
- **The child's own VRAM check is placement, not tenancy.** `plan_placement`
  still sizes accelerate's `max_memory` from torch's view and can still refuse
  (source `placement`); it answers "can the encoder be placed", not "may heavy
  work start".

## Cuts not yet mapped

- RPS beats through Vili (`motion-pipeline:follow_up:rps-clips-from-vili`), after
  the gate and `vili-fbx-export`. They wait on the household's yes on Raven.
