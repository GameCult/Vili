# Vili Verse Service Contract

## Objective

Vili turns Persona performance intent into animation work. The near-term body is
Kimodo on Raven; the durable contract is a service surface that can accept a
gesture/action prompt, run or queue motion synthesis, and publish inspectable
state for Odin and Idunn.

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
- The request omits a concrete prompt.

## First Runtime Invariant

Health checks must be cheap. They may verify process, port, backend metadata,
and cached readiness, but they must not launch a Kimodo generation job.
