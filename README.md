# Vili

Vili is the GameCult Persona animation daemon.

It owns the bridge from Persona performance intent to body-motion generation. Its
first backend is Kimodo on Raven, running through Docker Engine inside
`Ubuntu-24.04` WSL with NVIDIA GPU passthrough.

## Authority

- Vili owns animation job intake, Kimodo runtime checks, generated motion
  artifact references, and its operator/provider surface.
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

## Current Blocker

Actual Kimodo generation requires a Hugging Face token with access to gated
`meta-llama/Meta-Llama-3-8B-Instruct`. Without it, Vili can verify Kimodo and
CUDA, but generation fails at model fetch.
