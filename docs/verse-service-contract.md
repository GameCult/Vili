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

- `.vili/provider-advertisement.json`: compatibility provider advertisement.
- `.vili/operator-state.json`: daemon health and backend readiness.
- `.vili/eve-operator-surface.json`: current operator surface.
- `.vili/jobs/{jobId}.json`: accepted animation job records.
- `.vili/artifacts/{jobId}/`: generated motion outputs when generation succeeds.
- `vili-kimodo-worker`: resident Docker container exposing the loaded Kimodo
  model to Vili inside Raven's `Ubuntu-24.04` WSL runtime.

JSON is currently a compatibility witness because Raven's first Vili body is a
small Node daemon. Promotion to `.cc` CultCache witnesses should happen when the
animation job schema stabilizes.

## Command Boundary

`POST /motion/generate` accepts an explicit animation request:

```json
{
  "prompt": "a person gives a small friendly wave",
  "duration": 2,
  "diffusionSteps": 20,
  "seed": 123,
  "output": "wave-test",
  "bvh": true
}
```

The daemon may reject or defer requests when:

- Kimodo image is unavailable.
- Docker/GPU backend is unhealthy.
- Hugging Face token is absent and the selected backend requires gated model
  access.
- The resident Kimodo worker cannot start or does not become healthy before the
  request timeout.
- The request omits a concrete prompt.

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
