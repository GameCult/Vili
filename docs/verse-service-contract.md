# Vili Verse Service Contract

## Objective

Vili turns Persona performance intent into animation work. The near-term body is
Kimodo on Raven; the durable contract is a service surface that can accept a
gesture/action prompt, run or queue motion synthesis, and publish inspectable
state for Odin and Idunn.

Vili is an animation service, not a per-request CLI wrapper. Its Kimodo backend
is a resident worker container that owns model lifetime for generation requests.

## CultMesh Verses

- `vili.service`: service identity, provider advertisement, health, and runtime.
- `vili.animation`: animation jobs, prompts, backend choices, and artifact refs.
- `vili.operator`: daemon status, backend readiness, and Eve/CultUI surface.

## Witnesses

- `.vili/vili.service.cc`: Vili-owned CultCache store for provider
  advertisement, operator state, Eve surface, command boundary, and transport
  profile records.
- `.vili/provider-advertisement.json`: compatibility export derived from the
  provider advertisement record.
- `.vili/operator-state.json`: compatibility export derived from daemon health
  and backend readiness.
- `.vili/eve-operator-surface.json`: compatibility export of the current
  operator surface.
- `.vili/command-boundary.json`: compatibility export of Vili command
  authority.
- `.vili/transport-profile.json`: compatibility export of Vili transport
  state.
- `.vili/jobs/{jobId}.json`: accepted animation job records.
- `.vili/artifacts/{jobId}/`: generated motion outputs when generation succeeds.
- `vili-kimodo-worker`: resident Docker container exposing the loaded Kimodo
  model to Vili inside Raven's `Ubuntu-24.04` WSL runtime.

JSON is a compatibility witness. Vili's service/operator/command/transport
truth is the daemon-owned `.cc` store; animation job schemas may still be
promoted from JSON once that request/receipt shape stabilizes.

## Command Boundary

`POST /motion/generate` accepts an explicit animation request and forwards the
supported Kimodo generation controls to the resident worker. Vili owns job
identity, request persistence, worker lifecycle, timeout handling, and the
artifact stem. Kimodo owns synthesis and model-specific export.

```json
{
  "prompt": "a person gives a small friendly wave",
  "duration": 1,
  "diffusionSteps": 20,
  "seed": 123,
  "bvh": true
}
```

Kimodo metadata can be sent directly when callers need multi-segment or
multi-sample generation:

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
  "model": "Kimodo-SOMA-RP-v1.1",
  "numTransitionFrames": 3,
  "cfgType": "regular",
  "cfgWeight": [1.5],
  "seed": 6101,
  "bvh": true,
  "bvhStandardTpose": true,
  "saveExampleDir": true
}
```

Request fields accepted by Vili:

- `prompt` / `utterance` plus `duration` / `durationSeconds`
- `texts` plus `durations`, or a full `meta` object
- `inputFolder` / `input_folder` for a container-visible Kimodo input folder
  containing `meta.json` and optional `constraints.json`
- `model`; the daemon keeps one resident model loaded, so a model change
  restarts `vili-kimodo-worker`
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

Vili does not accept arbitrary `output` paths from callers. Every generation
writes beneath `.vili/artifacts/{jobId}/`, with the worker receiving
`/outputs/{jobId}/motion`. The job record is the authority for artifact refs.
Model-specific exports are preserved: SOMA writes NPZ and optional BVH, SMPLX
also writes AMASS NPZ, and G1 also writes CSV.

The daemon may reject or defer requests when:

- Kimodo image is unavailable.
- Docker/GPU backend is unhealthy.
- Hugging Face token is absent and the selected backend requires gated model
  access.
- The resident Kimodo worker cannot start or does not become healthy before the
  request timeout.
- The request omits concrete prompt, metadata, batch text, or input-folder
  intent.
- Batch `texts` are provided without matching `durations`.

## Credential State

Raven has a Hugging Face token installed in the `Ubuntu-24.04` WSL cache, and
Vili mounts it into Kimodo containers read-only. Verified on `2026-06-12`: a
Kimodo container launched by Raven could read gated metadata for
`meta-llama/Meta-Llama-3-8B-Instruct`.

## Kimodo Worker Boundary

The resident worker is started by Vili as Docker container `vili-kimodo-worker`.
Because Raven's Docker Engine lives inside WSL, Vili also starts a minimal WSL
keepalive process recorded at `/tmp/vili-wsl-keepalive.pid`; it owns no service
truth and exists only to keep the Docker substrate alive while the resident
worker holds the model.

It mounts:

- `/root/.cache/huggingface` for model/token access.
- `E:\Projects\Vili\scripts\kimodo-resident-worker.py` as the worker program.
- `E:\Projects\Vili\.vili\artifacts` as `/outputs` for generated artifacts.

Inside the worker, Kimodo owns synthesis. Vili owns worker lifecycle,
request/response persistence, timeout handling, and artifact references. Direct
user requests, programmatic requests, and smoke-started warmup all use the same
resident worker health and generation path.

Observed on `2026-06-12`: first worker model load took about 100 seconds. Once
resident, five 1 second / 20 step service-path generations averaged about
54.4 seconds per clip, or about `0.0184x` realtime.

## First Runtime Invariant

Health checks must be cheap. They may verify process, port, backend metadata,
and cached readiness, but they must not launch a Kimodo generation job or start
model load. Smoke checks may start the resident worker because their purpose is
backend readiness, not cheap liveness.
