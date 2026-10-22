# NVIDIA motion generation since Kimodo 6bb5848 (facts only)

Serves fork: motion-pipeline: which motion model and text encoder Vili runs
(`motion-pipeline:follow_up:kimodo-v1-2`; `motion-pipeline:target:r1`;
`motion-pipeline:ruling:encoder-transient-gpu`; `motion-pipeline:ruling:blender-body-portable`).
Gathered 2026-10-22 by Eyes (eyes-nvidia-motion, session sp-reentry-2026-10-21).
No conclusions or recommendations. "UNVERIFIED" marks anything not read from a primary source.

Baseline: nv-tlabs/kimodo `6bb5848` (2026-06-08, "Update README.md"), checkpoint Kimodo-SOMA-RP-v1.1.

## 1. Kimodo upstream since 6bb5848

Source: `gh api repos/nv-tlabs/kimodo/compare/6bb5848...main` (ahead_by 21; head `e1c219c`, 2026-10-15).
Repo code license: Apache-2.0 (GitHub API). https://github.com/nv-tlabs/kimodo

Commits (all dated): 1aece8c 2026-07-13 README ARDY; f12db15/58e7818 2026-09-22 MotionCorrection venv build fix (PR #51);
261dfa3, 6b4a2b8, 9840c2f, 6038600 2026-10-07 ArdyMotionRep + registry + benchmark sync; 0c137e3, 8dc66bf 2026-10-07 leak caveat docs;
c74eb21, 1588833 2026-10-14; e47a0e9 2026-10-14 `inverse-from-positions restores the pelvis at root height`;
ddaee74, 09d2db6, 2888784 2026-10-14; 342a2ca 2026-10-14 TF32 disabled in benchmark; 9266dde, 39cd6f7, 0c967d3, e1c219c 2026-10-15.
Tag `v1.2` -> 0c967d3 (lightweight tag; no GitHub Release object, `releases/tags/v1.2` returns 404).

### New checkpoints (both 2026-10-15; HF created 2026-10-13)
- `nvidia/Kimodo-SOMA-RP-v1.2` https://huggingface.co/nvidia/Kimodo-SOMA-RP-v1.2 - smooth-root rep (same as v1.1). Default model for demo/CLI at main (CHANGELOG [2026-10-15]; docs/source/user_guide/cli.md).
- `nvidia/Kimodo-SOMA-RP-ArdyRep-v1.2` https://huggingface.co/nvidia/Kimodo-SOMA-RP-ArdyRep-v1.2 - predicts ARDY motion rep (global root, raw hips as root) via `kimodo.motion_rep.ArdyMotionRep`; interoperable with ARDY constraints.
- Both: 282M params, 30 fps, max 10 s (300 frames), output root translation `[T,3]` + joint rotations `[T,30,3,3]`; `model.safetensors` 1,133,177,724 B (v1.2) vs 1,133,185,036 B (v1.1) (HF tree API).
- What changed (HF card "Changes in v1.2"; CHANGELOG): trained on corrected splits (BONES-SEED test sequences had leaked into v1.1 training set); v1.2 "reduces foot skating and matches constraint accuracy; its text-following scores (R-precision/FID) are slightly lower, partly reflecting the removed leakage". Benchmark tables: docs/source/benchmark/results.md at main (not transcribed here).
- Speed: no speed claim found in v1.2 card/changelog. UNVERIFIED beyond that absence.
- License on card: NVIDIA Open Model License; card states "ready for commercial use". Licence text (fetched 2026-10-22, https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/): NVIDIA "does not claim ownership" of outputs; outputs are not Derivative Models; grant covers commercial use; Sec 2.1 terminates rights if a safety guardrail is bypassed without a substantially similar one; redistribution needs the agreement copy + attribution notice.

### Text encoder: unchanged (answer to the running cut)
- No file under `kimodo/model/llm2vec/` changed since 6bb5848: last commit touching it is 191af10 (2026-04-25, adds `TEXT_ENCODER_DEVICE`), before the baseline (`gh api commits?path=kimodo/model/llm2vec`). The compare file list contains no llm2vec, load_model, or text_encoder file.
- `kimodo/model/load_model.py` at main: `DEFAULT_TEXT_ENCODER="llm2vec"`, `LLM2VecEncoder`, base `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp`, peft `McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised`, `dtype: "bfloat16"`.
  `kimodo/scripts/run_text_encoder_server.py` has the same preset; `--fp32`-style flag switches to float32 (line 67/86).
- Checkpoint config.yaml: v1.2 and v1.1 both `llm_shape: [1, 4096]`, `num_text_tokens_override: 50`, `use_text_mask: false`, `latent_dim 1024`, `num_layers 16`; ArdyRep-v1.2 identical on these keys (raw config.yaml on HF for all three).
- README at main: "~17GB of VRAM to generate locally entirely on GPU, primarily due to the text embedding model"; `TEXT_ENCODER_DEVICE=cpu` -> "<3 GB" (README lines 76; unchanged since 2026-04-24 entry). Vendored llm2vec is patched for `transformers==5.0.0rc3` (llm2vec/README.md).
- Inference code touching embeddings: `TextEncoderAPI` (`kimodo/model/text_encoder_api.py`) default URL `http://127.0.0.1:9550/`, `dtype=torch.float` on the client side (unchanged).
- Not verified: byte-level identity of v1.1/v1.2 embeddings pipelines at runtime (only static diff read).

### Skeleton / export (SOMA, Blender FBX step)
- Model skeleton still `kimodo.skeleton.SOMASkeleton30` in all three configs. Exported NPZ uses `somaskel77`; BVH export (`--bvh`, SOMA only, somaskel77, offsets scaled m->cm, BONES-SEED rest pose by default, `--bvh_standard_tpose` for T-pose) - docs/source/user_guide/output_formats.md at main. BVH T-pose option added 2026-04-13 (c6e3fa3), before baseline.
- `kimodo/exports/` has bvh.py, mujoco.py, smplx.py, motion_convert_lib.py, motion_io.py, motion_formats.py; last change to that dir is c6e3fa3 (2026-04-13). No FBX exporter in the tree (path listing grep for fbx/unity/mecanim returned nothing outside C++ math files).
- New at main: `ArdyMotionRep` (only for the ArdyRep checkpoint) and `skeleton/kinematics.py` +86 lines; commit e47a0e9 changes inverse-from-positions pelvis root height (motion_rep, not exporter). Interaction with v1.2 smooth-root export: not examined.
- Breaking rename in metrics: `ContraintFollow` -> `ConstraintFollow` (benchmark only).

## 2. Other NVIDIA motion generation in the window

| Item | Date | Link | Claim |
|---|---|---|---|
| ARDY (SIGGRAPH 2026, ACM TOG 45(4):86, DOI 10.1145/3811284) | repo created 2026-07-08; checkpoints 2026-07-10; SOMA ckpts 2026-10-15 | https://github.com/nv-tlabs/ardy ; https://research.nvidia.com/labs/sil/projects/ardy/ | Autoregressive diffusion, streaming text + kinematic constraints, "real-time responsiveness" (no latency number on project page). Code Apache-2.0; weights NVIDIA Open Model (README table). |
| ARDY-SOMA-RP-30FPS-Horizon60 and -KimodoRep-Horizon60 | 2026-10-15 | https://huggingface.co/nvidia/ARDY-SOMA-RP-30FPS-Horizon60 | SOMA 30-joint skeleton, 30 fps, 192M params (text encoder excluded), max 8 s output, "ready for commercial or non-commercial use", global root + joint rotations. Card states it "cannot create cartoon motions or non-physically plausible motions"; best at locomotion, gestures, combat, dancing, everyday activities. |
| ARDY other ckpts | 2026-07-10 | repo README table | Core 27-joint 20 fps (H40, H8); Unitree G1 25 fps (H52, H8). |
| ARDY text encoder / VRAM | - | ardy README "GUI Reference" | LLM2Vec (gated meta-llama/Meta-Llama-3-8B-Instruct); options cuda/bfloat16 default "~14 GB VRAM", cuda/float32, cpu/bf16, cpu/fp32. Tested on RTX 4090 (Ubuntu 22.04); TensorRT optional. Same encoder family as Kimodo. |
| MotionBricks (SIGGRAPH 2026) | arXiv 2026-04-27 (2604.24833); code preview 2026-04-23/27 | https://nvlabs.github.io/motionbricks/ ; https://github.com/NVlabs/GR00T-WholeBodyControl/tree/main/motionbricks | Real-time latent generative model + "smart primitives"; control by velocity, heading, style, keyframes - not text. Claims 15,000 FPS / 2 ms latency. Demo targets Unitree G1; checkpoints ~2.2 GB via Git LFS. Repo license: dual - source Apache-2.0, model weights NVIDIA Open Model (LICENSE). Output skeleton for SOMA/humanoid rig: UNVERIFIED (G1 demos only). Last motionbricks commit 2026-05-01. |
| GEM-X | repo pushed 2026-10-22 | https://github.com/NVlabs/GEM-X | Monocular whole-body 3D pose estimation using SOMA (video -> motion; not text-to-motion). Description read only. |
| BONES-SEED dataset | - | https://huggingface.co/datasets/bones-studio/seed | 350k mocap clips per MotionBricks page; SOMA and G1 formats per SOMA-X README. |
| Kimodo tech report | 2026-03 | https://arxiv.org/abs/2603.15546 | Paper for Kimodo (cited; not re-read in this pass). |
| SONIC / GENMO | - | - | Searched; no primary-source facts gathered. UNVERIFIED. |

Hardware statements for Kimodo (README): tested on RTX 3090, RTX 4090, A100; HF card lists Ampere, Lovelace, Blackwell; Windows and Linux supported.

## 3. NVIDIA retargeting tooling

- SOMA Retargeter https://github.com/NVIDIA/soma-retargeter (Apache-2.0; created 2026-03-10; pushed 2026-10-01; "active beta"): input SOMA-base-skeleton BVH; output robot joint CSV; bundled robots unitree_g1, unitree_h2, booster_t1, agibot_x2ultra, agibot-a3t3; "tools for configuring another robot" (robot configurator doc). Built on Newton and Warp. README documents robot targets only; no Mecanim/Unity/FBX path in its README. Code search for fbx/unity/mecanim in soma-retargeter, SOMA-X, kimodo, ardy: no relevant hits (usd-core license file, C++ math files only; two queries for ardy hit the rate limit, UNVERIFIED for ardy).
- SOMA-X https://github.com/NVlabs/SOMA-X (Apache-2.0; pushed 2026-10-09): body model; "pose inversion, procedural rig controls, smoothing, conversion, USD/NPZ I/O"; unifies identity models (SMPL-family, MHR, Anny) under one SOMA skeleton "so applications can reuse one animation, retargeting, and geometry pipeline". Assets from https://huggingface.co/nvidia/SOMA-X. No humanoid-game-rig retarget documented in README as read.
- ProtoMotions https://github.com/NVlabs/ProtoMotions (Apache-2.0; pushed 2026-10-16): physics-based humanoid simulation/training; Kimodo README lists it as downstream.
- No NVIDIA Unity Mecanim retargeter found. Absence established only by the searches above, not exhaustively.

## Evidence gaps
- Benchmark numbers (docs/source/benchmark/results.md) not transcribed.
- v1.2 weights not downloaded; no runtime check.
- ARDY paper PDF and Kimodo tech report not read; project-page fetches were summarized by a fetch model.
