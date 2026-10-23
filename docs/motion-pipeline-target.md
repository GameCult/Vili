# Motion pipeline: target

Date: 2026-10-20. Self, session `sp-reentry-2026-10-20`. Campaign `motion-pipeline`.

## Why it exists

Generated motion is a cross-game capability for GameCult. It saves hand-animating
specific beats in every game, and it makes generated cinematics possible. The
operator's ruling is `rps:ruling:generative-pipeline-is-strategic`. The first
consumer is the StreamPixels rock, paper, scissors duel
(`rps:ruling:rps-motion-via-vili`). Stitched Mixamo clips are not specific enough
for its countdown and throw.

## Where the body stands (2026-10-24)

- **Vili is a Linux CPU process tree** (Vili main `f2b35e3`), verified on
  Yggdrasil. It moves there under Idunn by `motion-pipeline:cut_spec:cut-vili-admission.r1`
  (`motion-pipeline:ruling:vili-moves-to-yggdrasil-now`). Until that cut lands and
  the Raven teardown follows, a retired Raven-era daemon still runs on Raven, with
  its GPU permission off; Raven is the household's machine
  (`motion-pipeline:ruling:raven-gpu-defers-to-household`).
- **One request returns** `motion.npz` and optionally `motion.bvh`, on the SOMA
  77-joint skeleton, in centimetres. The skeleton has full hands, plus a
  synthetic `Root` above `Hips`.
- **There is no FBX export.** No Unity project has an avatar for the SOMA
  skeleton.

## The design truths this campaign produces

- **A text prompt becomes a Unity clip without any hand steps.** Constraints
  such as keyframe poses, end-effector targets and waypoints can steer it.
- **Vili owns generation and export.** It turns Kimodo output into an FBX
  animation on the SOMA skeleton, plus a reference to that artifact. It does
  not retarget to any game's rig.
- **The consuming engine owns retargeting through its own humanoid system.** In
  Unity that is one Humanoid avatar for the SOMA skeleton, defined once and
  shared by every clip. Mecanim maps each clip onto the game's rig, the same
  way it handles Mixamo clips today. There is no hand-written per-rig
  retargeter.
- **Every artifact records how it was made:** the prompt, the constraints, the
  seed, the model and its version. The same request reproduces the same clip.

## Not in scope

- Facial performance, lip sync, cameras and rendering. Vili's README assigns
  those to future renderers.
- Training or fine-tuning Kimodo.
