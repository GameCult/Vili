# Vili Verse Service Contract

## Objective

Vili turns Persona performance intent into animation work. It is an animation
service, not a per-request CLI wrapper: one daemon accepts a gesture or action
prompt, owns a resident Kimodo worker on CPU, and publishes inspectable state
for Odin and Idunn. The request fields and the runtime flags are in `README.md`
(Motion Generation, Local Runtime); this page holds the contract around them.

## CultMesh Verses

- `vili.service`: service identity, health, and runtime.
- `vili.animation`: animation jobs, prompts, backend choices, and artifact refs.
- `vili.operator`: daemon status and worker readiness, as typed state. Operator
  surfaces wait for Thing 2.

## Witnesses

- `.vili/vili.service.cc` (`/var/lib/gamecult/vili/vili.service.cc` under Idunn): the daemon-owned CultCache store for operator state,
  the command boundary and the transport profile.
- `.vili/jobs/{jobId}.json`: accepted animation job records.
- `.vili/artifacts/{jobId}/`: generated motion outputs when generation succeeds.
- `.vili/embeddings/text-embeddings.cc`: the worker's text-embedding cache.
- `.vili/worker.pid`: the hand-run daemon's only: the process group of the running
  worker, so a restarted hand-run daemon can find and kill a worker its crashed
  predecessor left behind. Under Idunn it is never written; the unit's cgroup owns the tree.
- `.vili/daemon.lock` (hand-run) and Idunn's process write lease (Yggdrasil): the
  writer authority for the state root. No state is written before the lease is held.
- `.vili/logs/worker.log`: the worker's stdout and stderr.

## Command Boundary

`POST /motion/generate` accepts an explicit animation request and forwards the
supported Kimodo generation controls to the resident worker. Vili owns job
identity, request persistence, worker lifecycle, timeout handling, and the
artifact stem. Kimodo owns synthesis and model-specific export.

Vili does not accept arbitrary `output` paths from callers. Every generation
writes beneath `.vili/artifacts/{jobId}/`, and the job record is the authority
for artifact refs. SOMA writes NPZ and optional BVH, SMPLX also writes AMASS NPZ,
and G1 also writes CSV.

A POST that carries an `Origin` header or is not `application/json` is refused
`403 cross-site` before its body is read.

The daemon refuses or fails a request when:

- the models root, Kimodo commit or Python environment id is not configured
  (`503 worker-unconfigured`, before anything spawns);
- the worker cannot start or does not become healthy in time (a `502` job);
- the request omits concrete prompt, metadata, batch text, or input-folder
  intent;
- batch `texts` are provided without matching `durations`.

## Worker Boundary

The daemon spawns the resident worker as a child on the first job, in its own
process group, at nice 10, with a closed environment and the thread budget
`--threads`. The worker binds its own port and reports it in a ready line. The
daemon owns the group: it kills the whole group when the worker exits for any
reason (so no encoder child survives), on SIGTERM or SIGINT, and at start-up for
a group left by a crashed daemon. Under a service manager, the unit should also
own the tree from outside (systemd `KillMode=control-group`).

Inside the worker, Kimodo owns synthesis and a one-shot encoder child owns
text encoding on a cache miss. Health checks must be cheap: `/health` reads the
daemon's own worker state and never starts a model load or a generation.
