# Vili

Vili is the GameCult Persona animation daemon.

It owns the bridge from Persona performance intent to body-motion generation. Its
first backend is Kimodo on Raven, running through Docker Engine inside
`Ubuntu-24.04` WSL with NVIDIA GPU passthrough.

## Front Door

- **Value:** a warm, supervised path from a text prompt to generated body motion. Vili runs Kimodo as a resident GPU worker on Raven and returns motion artifacts (`motion.npz`, optional BVH) for a job.
- **Problem:** Personas and games need generated motion, but cold per-request container runs took about 195 seconds per 1 second clip, versus about 54 warm. One daemon owns job identity, worker lifecycle and artifact references so callers do not touch Docker, WSL or model state.
- **Entry points:** `scripts/vili-daemon.mjs` (the daemon; `npm start`, `npm run health`, `npm run smoke`, `npm run provider`), `scripts/kimodo-resident-worker.py` (the resident worker), `POST /motion/generate` (see Motion Generation), `docs/verse-service-contract.md` and `docs/motion-pipeline-target.md`.
- **Live:** the resident Kimodo worker on Raven, `POST /motion/generate`, `GET /smoke`, and the CultCache service store. It runs under a Raven scheduled task, not under Idunn. It has `motion.npz` and optional BVH output on the SOMA skeleton; there is no FBX export.
- **Planned (target, 2026-10-20):** FBX animation export on the SOMA skeleton and a text-prompt-to-Unity-clip path with no hand steps, with each artifact recording prompt, constraints, seed and model. Retargeting stays with the consuming engine; see `docs/motion-pipeline-target.md`.

## Authority

- Vili owns animation job intake, Kimodo runtime checks, Kimodo resident worker
  lifecycle, generated motion artifact references, and its operator/provider
  surface.
- Personas and Weksa may propose performance intent, gesture prompts, and
  constraints.
- Kimodo owns motion synthesis.
- Future renderers own retargeting, playback, facial performance, camera, and
  lip sync.
- Odin discovers Vili; Odin does not own Vili's state.
- Vili is started at boot by its scheduled task on Raven today; nothing restarts it after a crash, and Idunn does not manage it until its admission is ruled (deferred until RPS has its clips). Idunn would not own animation decisions.

## Local Runtime

On Raven:

```powershell
scripts\restart-vili-daemon.cmd
```

Default compatibility endpoint:

```text
http://10.77.0.4:8824
```

Vili is not an Idunn target today. Its lifecycle is the `GameCult\Vili`
scheduled task on Raven, and `GET /health` is an operator lowering. Admission
to Idunn is motion-pipeline:question:vili-under-idunn.

Vili also writes daemon-owned service state to:

```text
.vili\vili.service.cc
```

That CultCache store owns the provider advertisement, operator state, Eve
surface, command boundary, and transport profile. The adjacent JSON files are
compatibility exports for tools that have not learned the `.cc` store yet.

Important routes:

- `GET /health`
- `GET /provider-advertisement`
- `GET /operator-state`
- `GET /eve/operator`
- `GET /eve/deck/providers`
- `WS /eve/deck/vili.animation`
- `GET /smoke`
- `POST /motion/generate`

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
- `inputFolder` / `input_folder` for a container-visible Kimodo input folder
  with `meta.json` and optional `constraints.json`
- `model`; changing the requested model restarts the single resident worker
- `diffusionSteps` / `diffusion_steps`
- `numSamples` / `num_samples`
- `numTransitionFrames` / `num_transition_frames`
- `constraints` as an object/list, or `constraints`, `constraintsPath`, or
  `constraints_path` as a container-visible path
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

Raven has a Hugging Face token installed at
`/root/.cache/huggingface/token` inside `Ubuntu-24.04`. Vili mounts that token
read-only into Kimodo containers and passes the standard Hugging Face token
environment variables.

Vili keeps Kimodo warm through a resident worker container named
`vili-kimodo-worker`. The worker loads the model once, exposes `/health` and
`/generate` inside WSL on `127.0.0.1:8825`, and serializes generation through
the loaded model. Because Raven's Docker Engine runs inside WSL, Vili also
keeps a tiny WSL sleep-loop alive while the worker is resident so the Docker
substrate does not disappear underneath the model. `GET /health` observes
worker state without launching model load. `GET /smoke` verifies the backend
and starts the resident worker when it is absent.

Kimodo's 8B text encoder (LLM2Vec, Llama 3) never lives in the worker. The
worker answers Kimodo's encoder call from a CultCache store of float32 vectors,
`.vili/embeddings/text-embeddings.cc` (`gamecult.vili.text_embedding.v0`, written
through the cultcache-py checkout mounted from `E:\Projects\CultLib`). A vector's
key is `sha256(encoderIdentity + newline + text)`, and the identity names the three
Hugging Face snapshot revisions, bfloat16, the transformers and peft versions and
the Kimodo commit, so a changed input misses instead of serving a stale vector.
Kimodo normalizes the prompt before encoding (`A person shrugs sadly.`), and the
cache keys on that text. A request's misses go to one transient child,
`scripts/kimodo-text-encode.py`: it loads the encoder in bf16 on the GPU, with the
layers that do not fit in free VRAM held in RAM, encodes, writes its answer and
exits, so the OS reclaims its RAM and VRAM. It sizes its own placement from the free VRAM torch
can see and refuses a placement below 2 GiB with a typed `gpu-busy` (source `placement`);
it has no CPU fallback, and hits never touch it. Each
`/motion/generate` job carries the encoder record (hits, misses, seconds, vector
hashes) and the worker identity. `GET /health` shows the identity and the stored
count.

GPU tenancy. The daemon holds one GPU slot; a `POST /motion/generate` while another job holds it
is refused with HTTP 503, `retry-after: 60` and `{ ok: false, code: "gpu-busy", source: "slot" }`.
A job already running finishes; the gate never stops work. `npm test` runs the gate's tests.

Measured on Raven on `2026-10-22`, for a 2 second clip at 20 diffusion steps:
the worker is healthy 29 seconds after `docker rm` (was 179) and rests at 2.3 GiB
resident (was 10.4 GiB, with 5.8 GB swapped). A cache miss takes 59 to 103
seconds, the encode being nearly all of it (the 103 was with the model files cold
in the page cache); the CPU encoder took 316 to 376. A hit takes under one
second. The child peaks at 14.1 GiB of VRAM, so a miss needs almost the whole
16 GB card.
