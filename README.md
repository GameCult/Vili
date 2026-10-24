# Vili

Vili is the GameCult Persona animation daemon.

It owns the bridge from Persona performance intent to body-motion generation. Its
backend is Kimodo, run by Vili's own daemon as a CPU-only Python process tree on
Linux. It is built to run on Yggdrasil as an Idunn target (planned, not live; see Front Door).

## Front Door

- **Value:** a supervised path from a text prompt to generated body motion. The daemon spawns one resident Kimodo worker, caps its threads, and returns motion artifacts (`motion.npz`, optional BVH) for a job.
- **Problem:** Personas and games need generated motion, but cold per-request model loads cost minutes. One daemon owns job identity, worker lifecycle, the thread budget and artifact references, so callers touch no model state.
- **Entry points:** `scripts/vili-daemon.mjs` (the daemon; `npm start`, `npm test`), `scripts/idunn-entry.mjs` (the process Idunn runs), `deployment/idunn/recipe.toml` (the sealed release), `scripts/kimodo-resident-worker.py` (the worker it spawns), `scripts/kimodo-text-encode.py` (the one-shot encoder child), `POST /motion/generate` (see Motion Generation), `docs/verse-service-contract.md` and `docs/motion-pipeline-target.md`.
- **Live:** the process tree below, run by hand for development and tests: `POST /motion/generate`, `GET /health`, `GET /operator-state`, and the CultCache service store. It produces `motion.npz` and optional BVH on the SOMA skeleton; there is no FBX export.
- **Planned:** the Idunn target `vili` on Yggdrasil at `http://10.77.0.1:8824` over WireGuard, with its provisioning runbook in `gamecult-ops`; neither exists until the first `idunn up` lands. FBX export and a text-prompt-to-Unity-clip path with no hand steps (`docs/motion-pipeline-target.md`).

## Authority

- Vili owns animation job intake, the worker process lifecycle, and generated
  motion artifact references.
- Personas and Weksa may propose performance intent, gesture prompts, and
  constraints.
- Kimodo owns motion synthesis.
- Future renderers own retargeting, playback, facial performance, camera, and
  lip sync.
- Odin discovers Vili; Odin does not own Vili's state.
- Operator surfaces wait for Thing 2; today Vili publishes typed state and plain HTTP.

## Local Runtime

One Linux CPU process tree:

```text
vili-daemon.mjs          job intake, worker lifecycle, thread cap, nice 10
  kimodo-resident-worker.py   resident Kimodo model, one generation at a time
    kimodo-text-encode.py     one child per request with cache misses, on CPU
```

Setup: `git submodule update --init` (CultLib, Kimodo, SOMA-X); in `vendor/CultLib`, `npm ci --ignore-scripts` and
`npm run build --workspace=packages/cultcache-ts` and `--workspace=packages/cultnet-ts`; then `npm ci --install-links` here. The worker
needs a Python environment with Kimodo's pins and Kimodo itself importable, and a
Hugging Face cache (`<models root>/hub`) holding the Llama 3 base, both LLM2Vec
adapters and the Kimodo checkpoint. Everything runs offline.

```text
node scripts/vili-daemon.mjs --python <python> --models-root <hf home> --kimodo-commit <sha> --python-env <env id> [--threads 8]
```

Flags, each with an environment twin: `--host` (`VILI_DAEMON_HOST`, 127.0.0.1),
`--port` (`VILI_DAEMON_PORT`, 8824), `--state-root` (`VILI_STATE_ROOT`, `.vili`),
`--python` (`VILI_PYTHON`), `--worker-entry` (`VILI_WORKER_ENTRY`, the test seam),
`--models-root` (`VILI_MODELS_ROOT`), `--threads` (`VILI_THREADS`, 1 to 16, default
8), `--kimodo-commit` (`VILI_KIMODO_COMMIT`), `--python-env` (`VILI_PYTHON_ENV`, the
environment's identity). A generate request without a models root, Kimodo commit
and Python environment id gets `503 worker-unconfigured` before anything spawns.

The daemon starts the worker on the first job, on a port the worker binds itself
and reports in its ready line, and respawns it after an exit. The worker runs at
nice 10 with `torch` limited to `--threads` (also `OMP_NUM_THREADS` and
`MKL_NUM_THREADS`), so a shared host keeps its other services. Its log is
`<state>/logs/worker.log`. The daemon owns the whole worker process group: it is killed when the worker exits for any reason, on SIGTERM or SIGINT, and, for a hand-run daemon, at start-up if a crashed predecessor left one (`<state>/worker.pid`). Under Idunn the unit's cgroup owns the tree.

A hand-run daemon holds its state root through a listening socket in Linux's abstract namespace, named by the root's real path: the bind is the atomic claim, so a second daemon on a live root prints that it is held and exits 2, killing nothing, and a dead daemon's claim is gone with it (there is no lock file). Two daemons in separate network namespaces do not exclude each other.

### On Yggdrasil

Idunn runs `node vili/scripts/idunn-entry.mjs --state-root <root> --kimodo-commit <sha>` from a sealed release of three trees: `node`, `vili` (the daemon, worker, child, `node_modules`, cultcache-py) and `python` (python-build-standalone CPython 3.12 with the hash-locked packages, Kimodo, MotionCorrection and SOMA-X installed into it; no venv). The weights are the read-only cache `/srv/vili/models`; state is `/var/lib/gamecult/vili`. Idunn's process write lease is the one writer authority: until the daemon holds it, `POST /motion/generate` answers `503 write-lease-pending` and nothing is written; the lease is asked every 250 ms and at every write, so if it is lost the worker tree is SIGKILLed within a second and the daemon answers `503 write-lease-lost`. From SIGTERM on the daemon accepts nothing and writes and spawns nothing (`503 stopping` for a request in flight), stops the worker tree, and exits 0. Idunn proves readiness with its own `POST /cultnet/snapshot` challenge, answered with a signed runtime presence (an `Origin` is still refused).

`POST /motion/generate` refuses any POST that carries an `Origin` or is not
`application/json` with `403 cross-site`; no route answers a preflight.

Vili writes daemon-owned state to `.vili/vili.service.cc`: operator state, the
command boundary and the transport profile. Jobs are `.vili/jobs/<jobId>.json`,
artifacts `.vili/artifacts/<jobId>/`.

Routes: `GET /health`, `GET /operator-state`, `POST /motion/generate`; under Idunn also `POST /cultnet/snapshot`, Idunn's route challenge.

## Motion Generation

`POST /motion/generate` exposes Kimodo's generation surface through the
resident worker. Vili owns job identity, persistence, timeout handling, worker
lifecycle, and the output stem; Kimodo owns synthesis and model-specific export
formats.

Minimal request:

```json
{
  "prompt": "a person gives a small friendly wave",
  "duration": 1,
  "diffusionSteps": 20,
  "bvh": true
}
```

Batch requests can use Kimodo-style metadata:

```json
{
  "meta": {
    "texts": [
      "a person gives a small friendly wave",
      "a person takes one careful step"
    ],
    "durations": [0.5, 0.5],
    "num_samples": 1,
    "diffusion_steps": 20
  },
  "numTransitionFrames": 3,
  "cfgType": "regular",
  "cfgWeight": [1.5],
  "seed": 6101,
  "bvh": true,
  "bvhStandardTpose": true,
  "saveExampleDir": true
}
```

Supported request fields:

- `prompt` / `utterance` plus `duration` / `durationSeconds`
- `texts` plus `durations`, or a full `meta` object
- `inputFolder` / `input_folder` for a Kimodo input folder on the worker host
  with `meta.json` and optional `constraints.json`
- `model`; changing the requested model restarts the single resident worker
- `diffusionSteps` / `diffusion_steps`
- `numSamples` / `num_samples`
- `numTransitionFrames` / `num_transition_frames`
- `constraints` as an object/list, or `constraints`, `constraintsPath`, or
  `constraints_path` as a path on the worker host
- `seed`
- `cfg`, `cfgType` / `cfg_type`, `cfgWeight` / `cfg_weight`
- `bvh`, `bvhStandardTpose` / `bvh_standard_tpose`
- `noPostprocess` / `no_postprocess`
- `saveExampleDir` / `save_example_dir`
- `timeoutMs`, `workerTimeoutMs`

Vili intentionally does not accept an arbitrary Kimodo output path. Generated
artifacts are written under `.vili/artifacts/{jobId}/` and referenced from the
job record. `Kimodo-SOMA-RP-v1.1` produces NPZ and optional BVH output,
`Kimodo-SMPLX-RP-v1.1` also exports AMASS NPZ, and `Kimodo-G1-RP-v1.1` also
exports CSV when that model is resident.

## Current Runtime State

Kimodo's 8B text encoder (LLM2Vec, Llama 3) never lives in the worker. The
worker answers Kimodo's encoder call from a CultCache store of float32 vectors,
`<state>/embeddings/text-embeddings.cc` (`gamecult.vili.text_embedding.v0`, through
the cultcache-py in `vendor/CultLib`). A vector's key is
`sha256(encoderIdentity + newline + text)`. The identity names the three Hugging
Face snapshot revisions, the encoder assembly and prompt form, the device, dtype, the torch,
transformers, peft and accelerate versions, the Kimodo commit and the sha256 of
`kimodo-text-encode.py`, so a changed input misses instead of serving a stale
vector. Thread count is provenance, recorded in the worker identity, not identity.

The encoder is the Llama 3 base with the MNTP adapter merged, then the supervised
adapter, in bfloat16 on CPU, and `kimodo-text-encode.py` wraps every prompt in
Llama 3 Instruct's chat header itself (`text_encoding.chat_header`, pooled after
LLM2Vec's query marker), as Kimodo's LLM2Vec does when loaded from the repo ids. The identity names that prompt form.
A fresh child vector matches Kimodo's own encoder from the repo ids
(`test_text_encoding.ReferenceVector`, run on Yggdrasil). The measured timings are
in `docs/research/vili-on-yggdrasil-cpu-2026-10.md`. Kimodo normalizes the prompt before encoding (`A person shrugs sadly.`),
and the cache keys on that text. A request's misses go to one transient child that
loads the encoder, encodes, writes its answer and exits, so the OS reclaims its
RAM; hits never touch it. Each job carries the encoder record (hits, misses,
seconds, vector hashes) and the worker identity. The cache starts empty on a new
host: vectors from another assembly or device are never copied in.
