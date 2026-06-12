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
