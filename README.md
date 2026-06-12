# Vili

Vili is the GameCult Persona animation daemon.

It owns the bridge from Persona performance intent to body-motion generation. Its
first backend is Kimodo on Raven, running through Docker Engine inside
`Ubuntu-24.04` WSL with NVIDIA GPU passthrough.

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
- Idunn keeps Vili alive; Idunn does not own animation decisions.

## Local Runtime

On Raven:

```powershell
E:\Projects\Vili\scripts\restart-vili-daemon.cmd
```

Default compatibility endpoint:

```text
http://10.77.0.4:8824
```

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

Verified on `2026-06-12`: the resident worker loaded
`Kimodo-SOMA-RP-v1.1` on Raven's RTX 4060 Ti in about 100 seconds. Five warmed
service-path generations of a 1 second clip at 20 diffusion steps averaged
about 54.4 seconds each, roughly `0.0184x` realtime. The old per-request
`docker run --rm kimodo_gen` path measured about 195 seconds per 1 second clip
and is no longer the generation authority.
