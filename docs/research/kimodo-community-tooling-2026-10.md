# Community tooling around Kimodo, SOMA and ARDY (facts only)

Serves cuts: `motion-pipeline:cut_spec:cut-vili-fbx-export.r1` (BVH -> Blender -> FBX) and
`motion-pipeline:cut_spec:cut-soma-humanoid-avatar.r1` (SOMA77 Humanoid avatar in Unity 2021.3.45f2,
Mecanim retarget to LHMP); and the authoring-UX target `motion-pipeline:follow_up:vili-authoring-ux-target-2`.
Gathered 2026-10-23 by Eyes (eyes-kimodo-community, session sp-reentry-2026-10-21). No conclusions or recommendations.
Method: `gh api` (repo/code/issue search, READMEs, file reads, fork list), HF API, WebSearch/WebFetch.
Nothing below was installed or run; every "does" is from the README or the file named. "Last" = GitHub `pushed_at`
read 2026-10-23. Stars as read the same day. UNVERIFIED marks anything not read from a primary source.
Baseline: nv-tlabs/kimodo 3,875 stars, 433 forks, Apache-2.0, pushed 2026-10-15, 20 open issues.
Companion: `docs/research/nvidia-motion-since-kimodo-6bb5848.md`.

## 1. Exporters, importers, retargeters (SOMA/Kimodo -> FBX/BVH/glTF/engine)

### 1a. Unity
- https://github.com/Amin-HP/Kimodo-Unity (package `com.aminhp.kimodobridge`). Created 2026-07-23, last 2026-10-15,
  Apache-2.0, 8 stars. Unity package + FastAPI bridge server over Kimodo: generate, live preview, bake to Humanoid `.anim`.
  `Runtime/KimodoSomaHumanoid.cs` builds a source rig from the SOMA rest T-pose at runtime and calls
  `AvatarBuilder.BuildHumanAvatar`; motion reaches the target through Mecanim muscle space (`HumanPoseHandler`).
  Its mapping table: Hips; Spine1->Spine; Spine2->Chest; Chest->UpperChest; Neck1->Neck; Head; Jaw; Eyes;
  Shoulder/Arm/ForeArm/Hand; Leg->UpperLeg; Shin->LowerLeg; Foot; ToeBase->Toes; fingers 1..3 -> Proximal/Intermediate/Distal
  (file comment: unmapped joints such as Neck2 and *End leaves stay in the hierarchy, not exposed as human bones).
  Requires Unity 6000.0+ (README). Root bake mode Travel/InPlace; root-motion scale measured per character.
  Scene-view constraint gizmos, timeline of prompt segments, "freeze" segments. No FBX in the path.
  Demo: https://youtu.be/GlcN4yTN5CE
- https://github.com/OneYoungMean/KimodoUnityBridge (+ https://github.com/OneYoungMean/KimodoUnityBridge_FullDemo, 26 stars).
  Created 2026-05-19, last 2026-10-22, Apache-2.0, 110 stars, 18 forks, 0 open issues. Unity package via git URL.
  Prompt, pose/end-effector constraints, bake, retarget, Animator content, Timeline authoring, runtime playback.
  Ships `Runtime/Resources/SOMAAvatar.asset`, `SOMA_cskel27Avatar.asset` (ARDY Core), `SMPLXAvatar.asset`, `G1Avatar.asset`;
  `KimodoRigProfileDatabase.cs` holds SOMA77 names/parents. Bundles Kimodo and ARDY source under `NvlabKimodoQuickServer~/`.
  Requires Unity 2022.3+ and a Humanoid Animator. Also pose-from-video/picture via SMPL-X. README has an agent manual
  (SKILL.md, `Command/help.json`). Demo: https://www.bilibili.com/video/BV1HG7361Env
- https://github.com/GuardSkill/ComfyUI-Kimodo-Bridge. Created/last 2026-09-04, Apache-2.0, 1 star. ComfyUI nodes.
  "Export Unity Humanoid Bundle": animated FBX (motion retargeted onto a user-supplied Mixamo-rigged FBX through the
  Autodesk FBX SDK) + Unity AssetPostprocessor + manifest in a ZIP. Target is a Mixamo rig, not a SOMA avatar.
  Companion report https://github.com/GuardSkill/kimodo-retarget-report (0 stars, no licence; not read).
- https://github.com/micahmills88/animation-builder. Created 2026-04-24, last 2026-04-27, Apache-2.0, 12 stars. Docker web UI:
  prompt + user's Mixamo-rigged FBX -> animated FBX for Unity/Unreal. NPZ-direct retarget via Autodesk FBX SDK;
  README: "No Blender in the pipeline. No BVH intermediate." Needs ~17 GB VRAM.
- https://github.com/k0ta0uchi/TexMotion. Created 2026-08-24, last 2026-09-20, no licence stated, 0 stars. Unity/VRChat
  extension; in-editor inference through kimodo.cpp (`kimodo.dll`, ggml-vulkan), no Python; timeline pose editor; Modular Avatar.
- https://github.com/Anastasija42/vr-human-motion: code-search hit only; contains a copy of Amin-HP's package in a Unity
  project. Dates, licence, stars UNVERIFIED.

### 1b. Blender
- https://github.com/lewdineer/Kimodo_Blender_Bridge. Created 2026-04-29, last 2026-08-21, no licence stated, 154 stars, 32 forks.
  Blender 4.0+ add-on (has `blender_manifest.toml` for 4.2 extensions). Two-process bridge to a managed Kimodo venv;
  imports result into the scene with retargeting. Also sold at https://superhivemarket.com/products/kimodoblenderbridge .
  Tutorial https://youtu.be/nbiaS43Ncng . Tested (README): RTX 3090 Arch, "RTX 1080" Win11, RTX 5070 Win11.
- https://github.com/atticus-lv/kimodo_motion. 2026-06-17 / 2026-06-19, GPL-3.0, 44 stars. Blender 5.0+; 77-joint SOMA
  retargeted onto any humanoid armature inside Blender (FBX SDK no longer required); N variants as Actions
  `Kimodo_<prompt>_sNN`. Uses fork https://github.com/atticus-lv/kimodo (MPS/post-processing). Based on Xingxun7777.
- https://github.com/Xingxun7777/blender-kimodo-motion. 2026-04-17 / 2026-04-17, NOASSERTION (README says plugin MIT),
  11 stars. Blender 5.0.1+, Windows; retarget via Autodesk FBX SDK (`fbxsdkpy`). 16 GB VRAM stated.
- https://github.com/animatica-ai/animatica-blender-plugin. 2026-04-25 / 2026-10-21, GPL-3.0, 29 stars. Blender 5+
  "Choreographer": prompt blocks on timeline, key poses, waypoints, loop, in-place, variations, Accept/Reject per take.
  Cloud generation by default (https://animatica.ai/kimodo); self-host possible. Paid add-on "Marionette" sold separately.
  Backend https://github.com/animatica-ai/motionmcp-kimodo (2026-04-25 / 2026-05-27, Apache-2.0, 22 stars, alpha):
  "MMCP" HTTP protocol returning glTF (https://github.com/animatica-ai/motionmcp, 0 stars, Apache-2.0).
- https://github.com/qq2602247508-glitch/kimodo-to-mixamo-blender-addon. 2026-05-26 / 2026-05-28, no licence, 1 star.
  Blender add-on + patch to a Kimodo WebUI that exports standard T-pose BVH to Blender and retargets to Mixamo; loop-ready generation.
- https://github.com/Codemarchant/kimodo_NPZ_to_fbx_and_vrma. 2026-07-02 / 2026-07-02, MIT, 2 stars. NPZ -> FBX
  (Mixamo-named skeleton, skeleton-only, FBX SDK, Python 3.10) and VRMA. README claim: Kimodo native data is metres, Y-up,
  +Z forward, 30 fps, T-pose whose global rotations are identity, so no rest-pose correction; says default BVH rest is not a T-pose.
- https://github.com/Chrrxs/kimodo-r15-retarget. 2026-07-06 / 2026-07-06, MIT, 9 stars. SOMA BVH (`--bvh --bvh_standard_tpose`)
  -> Roblox R15 `.rbxmx`; collapsed chains, rest-pose corrections incl. "~17 degree forward rest-neck lean" (README). stdlib Python.
- https://github.com/Chidwi-commits/kimodo-bvh-retarget (MIT, 0 stars, 2026-06-01): README not read. UNVERIFIED.

### 1c. Unreal, Godot, other
- https://github.com/Conalh/Mocara-Unreal. 2026-08-24 / 2026-08-30, Apache-2.0, 12 stars. UE 5.8 plugin; Windows + WSL2 sidecar
  on 127.0.0.1:8765; imports SOMA BVH, builds target-specific IK Rig retarget onto Manny/MetaHuman; 1-4 sequential candidates
  with derived variation seeds ("peak VRAM at the proven single-motion level"); export newest clip to FBX.
- https://github.com/webportalim/MotionSmith-Kimodo-Animation-Studio. 2026-10-08 / 2026-10-19, no licence, 1 star. UE 5.8 plugin,
  Fab listing https://www.fab.com/listings/21c531e5-02b0-4d4a-960d-8cceab5dba34 (page not opened). Runtime installed separately.
- https://github.com/Jincat481/ARDY-Unreal-Offline-Pipeline. 2026-07-22 / 2026-10-18, no licence, 0 stars. Windows installer,
  ARDY -> Unreal FBX, UE 5.7 plugin with auto-retarget (README in Korean).
- https://github.com/wifimetas/kimodo-mcp. 2026-08-10, Apache-2.0, 1 star. MCP server; headless Blender BVH -> FBX
  ("centimetres, Z-up, baked, no leaf bones") or GLB, Unreal preset and "a Unity preset too"; 23 presets; QC for foot skate,
  ground penetration, jitter, loopability.
- https://github.com/localai-org/kimodo.cpp. 2026-08-22 / 2026-10-19, Apache-2.0, 929 stars. C++/GGML port, Vulkan or CPU;
  `animation.glb` export (skeleton-only; skinned-mesh GLB listed as planned); web demo. Windows fork
  https://github.com/TheLocalLab/kimodo.cpp-windows (2 stars; UE5 Mannequin retarget doc `docs/how_to_setup_with_unreal_in_windows.md`).
- Godot addons: https://github.com/shiena/godot-kimodo (Apache-2.0, 1 star, 2026-09-04) and
  https://github.com/Vega-KH/godot-kimodo (MIT, 0 stars, 2026-10-13); both produce native `Animation` resources. See section 2.
- https://github.com/V-Sekai-fire/interactor-kimodo-text-to-motion (MIT, 0 stars, 2026-10-10): README says only the stub contract
  stage works; retarget raises NotImplementedError.
- Unity Asset Store, extensions.blender.org: WebSearch (one query naming both) returned no listing; not browsed directly,
  so absence is UNVERIFIED. PyPI: animatica README says Kimodo "is not on PyPI"; PyPI search page not usable via curl.

### 1d. ARDY-specific
- https://github.com/iremoztrk/ardy2bvh. 2026-07-16, Apache-2.0, 20 stars (announced in nv-tlabs/kimodo issue #5). ARDY NPZ ->
  BVH, then headless Blender -> FBX. README: supports Core (cskel27) only; "SOMA - planned once NVIDIA releases the SOMA-skeleton
  checkpoints" (those appeared 2026-10-15; no later push seen).
- https://github.com/passive-hotpepper515/CEB_Ardy. 2026-08-05 / 2026-10-13, no licence, 0 stars. Blender add-on for ARDY
  (text, waypoints, crowds); distributed from a landing page ("GET CEB ARDY NOW").
- OneYoungMean/KimodoUnityBridge bundles `ardy/` and an ARDY Core avatar (1a).
- No community exporter for the ARDY-SOMA checkpoints found. GitHub code search for `somaskel77` and `SOMA77` in C#
  returned only Amin-HP copies and OneYoungMean.

### 1e. Upstream issues
- nv-tlabs/kimodo #15 (2026-03-31, closed): default BVH rest pose non-standard (kept for BONES-SEED consistency); maintainer
  added `--bvh_standard_tpose` (PR #26, 2026-04-13) and `somaskel77_standard_tpose.bvh`. #22 "T-Pose" (closed) holds a
  Blender retarget recipe by carlosedubarreto (linked from #15).
- #43 (2026-07-01, open): PR to cut BVH joint jitter by writing Euler angles from local matrices directly; reports jitter in the
  `soma-retargeter` viewer on boxing/squat clips. Merge state: open when read.
- #47 (2026-08-01, open): "Showcase: an open-source Unity front end for Kimodo".

## 2. UIs wrapping Kimodo (authoring UX prior art)
- ComfyUI: https://github.com/jtydhr88/ComfyUI-Kimodo (2026-03-31, no licence stated, 117 stars, 9 forks). Nodes: Load Model,
  Text Encode (reusable conditioning, "swap seeds without re-encoding"), Sampler (constraints, multi-prompt segments, multiple
  samples), Post Process (foot skate), Preview 2D/3D, Save NPZ, Export BVH, Export FBX (Mixamo). Derivatives: GuardSkill (1a),
  https://github.com/yogurt7771/ComfyUI-YogurtNodes-Kimodo (Apache-2.0, 2 stars),
  https://github.com/JayDataEngineer/melite-kimodo-nodes (MIT, 1, 2026-10-12),
  https://github.com/SchwenderOne/ComfyUI-Kimodo-Deps (0). comfy.icu lists GuardSkill and
  https://comfy.icu/extension/stevelittlefish__ComfyUI-Kimodo-Enhanced (not opened). registry.comfy.org not browsed; GuardSkill
  README says its registry listing awaits publisher setup.
- Godot: https://github.com/Vega-KH/godot-kimodo `addons/kimodo_motion/README.md` (read): create/reopen session; generate one or
  two takes; take selector with shared camera in preview; Save never overwrites silently; Accept adds the animation to a
  production AnimationLibrary (replace needs confirmation; Godot Undo/Redo); every source take archived; History reloads takes
  offline; Pose Library dock. "Stage 1 complete, final manual tests passed 2026-10-01"; reference GPU RTX 4070 Laptop 8 GB.
  Its backend repo https://github.com/Vega-KH/kimodo-godot-server returned the motionmcp-kimodo README (0 stars, Apache-2.0).
- micahmills88/animation-builder (1a): browser viewer, per-frame pose-distance, draggable trim markers, pairwise auto-trim,
  cyclic-blend or bridge loop closure, in-place regenerate; walkthrough in `docs/TUTORIAL.md`.
- Amin-HP (1a): segment timeline with freeze/regenerate-the-rest; progress read from the denoising loop; bake.
- animatica Blender plugin (1b): review-before-commit Accept/Reject, variations, loop, in-place.
- Mocara (1c): 1-4 candidates with derived seeds; retarget preview on Manny/MetaHuman.
- OneYoungMean (1a): Timeline clips with "Generate & Bake"; `output_mp4` option on its TCP generate command.
- kimodo.cpp browser demo: persistent history; selecting a previous animation restores prompt and encoder choice (README).
- https://github.com/rehan-remade/nvidia-kimodo (2026-07-07, no licence, 35 stars): Next.js + react-three-fiber viewer, Kimodo on
  fal H100, SSE denoising progress, retarget to ReadyPlayerMe/Mixamo GLBs in low-poly worlds.
- Not read: SifuInTheShell/GodotAnimGenerator, fkrn75/kimodo-mcp, polats/kimodo-motion-api.

## 3. Consumer GPUs and the 8B text encoder
- Upstream README via https://smeltcore.com/recipes/kimodo-on-rtx-3060-text-to-3d-motion-generation-guide/ (dated 2026-06-14):
  ~17 GB all-GPU; `TEXT_ENCODER_DEVICE=cpu` gives "<3 GB"; maintainer confirms ~3 GB in upstream issue #27 (as cited there).
  No seconds figure on that page.
- Amin-HP: encoder on CPU by default; "about 8 GB of VRAM is enough"; "tens of seconds" per generation because the prompt is
  re-encoded on CPU every time (package README).
- lewdineer: "Low VRAM? Run `kimodo_textencoder --device cpu`".
- https://github.com/Aero-Ex/kimodo fork (49 stars, Apache-2.0, pushed 2026-06-18; 16 ahead / 32 behind upstream main as
  read): encoder loaded, used, then evicted to RAM; `python -m kimodo.demo --offload` for "less than 8gb vram hardware".
  Uses HF `Aero-Ex/KIMODO-Meta3_llm2vec_NF4` (created 2026-04-04, 4.65 GB safetensors, 14,225 downloads, 10 likes, licence field
  empty in the HF API) and an FP16 variant. wifimetas/kimodo-mcp states this fork makes "6 GB cards viable" (its README; I did
  not measure). Video it links: https://www.youtube.com/watch?v=nNmeuvew8LY (PixelArtistry "6gb vram"; not watched).
- Other quantised encoders on HF (API list, unread): `matbee/kimodo-llm2vec-nf4`, `oneyoungmean/KIMODO-Meta3_llm2vec_INT8`,
  `OzzyGT/Kimodo_SOMA_RP_v1_2` with `_sdnq_dynamic_4bit` / `_8bit` variants, `LocalAI-io/Llama-3-Kimodo-GGML` (161,096 downloads;
  Q8_0 default, options bf16/q6_k/q5_k/q4_k/q4_k_m per kimodo.cpp README), `LocalAI-io/Kimodo-SOMA-RP-v1.1-GGML` (17,586 downloads).
- shiena/godot-kimodo README (kimodo.cpp based): "2 GB in practice, 1002 MiB at the floor"; disk 15.2 GiB (14.14 GiB text bundle).
- Different encoder: https://github.com/ArtyomITA/lfm-to-kimodo (2026-10-05, Apache-2.0, 0 stars, 1 fork). Replaces Llama-3-8B with
  LiquidAI/LFM2.5-Embedding-350M plus a linear map 1024->4096 trained on 14k pairs; targets Kimodo-SOMA-RP-v1.1. Its table:
  0.7 s/sentence vs 90-190 s; 700 MB vs 15 GB; cosine 0.815 EN; right sentence first try 97.8% EN / 93.0% IT; "fine details,
  which hand or side, sometimes drift". Self-reported. Outputs npz and bvh.
- Hardware named in READMEs: lewdineer RTX 3090/5070/1080; Vega-KH 4070 Laptop 8 GB; atticus-lv and Xingxun 16 GB+; animation-builder 17 GB.
  No 16 GB placement benchmark found (UNVERIFIED).

## 4. Stylized or cartoon characters
- NVIDIA model card sentence "cannot create cartoon motions" surfaced by WebSearch from the Kimodo HF cards; the ARDY SOMA card
  carries it too (companion doc). Not re-read from the Kimodo card in this pass.
- https://github.com/sprited-ai/dancing-chibi-figures (2026-08-20, MIT, 0 stars): ARDY (not Kimodo) NPZ -> chibi template rig,
  2.75-2.86 heads tall, Blender. `experiments/README.md`: same rotations, scaled rest offsets, root vertical scaled by leg ratio;
  root horizontal travel at human stride made feet skate; setting it to the 0.65 leg ratio fixed it, "plain uniform retargeting,
  no IK"; residual slide "inherited" from ARDY. Dataset https://huggingface.co/datasets/sprited/dancing-chibi-figures (1,430 clips; not opened).
- rehan-remade (2): Kimodo on ReadyPlayerMe/Mixamo GLBs; no quality report.
- https://github.com/Calix-L/Kimodo-SOMA-RP-final-showcase (2026-08-20, MIT, 7 stars): post-training of Kimodo-SOMA-RP-v1.1 on 748
  hand-reviewed game-action clips (attack, jump, airborne, knockdown); README: single-domain full fine-tune lost base ability,
  mixed training with SEED replay mitigated it. Chinese; PDF report not read.
- nv-tlabs/kimodo issue search for "cartoon" and "stylized": no cartoon issue. WebSearch found no Reddit threads. No user report of
  quality on LHMP-like or other cartoon rigs found.

## 5. Not verified
- No repo was cloned or executed; no claim that any conversion works.
- Whether any tool targets Unity 2021.3 (stated minimums: Amin-HP 6000.0+, OneYoungMean 2022.3+; GuardSkill and animation-builder
  produce FBX, engine version not stated).
- Whether any Unity tool commits a SOMA humanDescription table into an FBX `.meta` (Amin-HP builds the avatar in code at runtime;
  OneYoungMean ships `.asset` avatars; their exact build code beyond the files named was not read).
- HF Spaces: `nvidia/Kimodo` (330 likes) is the only Kimodo space of note in the API list; same-named spaces show 0 likes.
- Forks of nv-tlabs/kimodo: 433 total; only the first 100 by stars were listed. Notable: Aero-Ex (49), qian2501 (13), ysysimon,
  GBCache, atticus-lv (7 each), errno-mmd (4, pushed 2026-09-12), SmayanDesai/kimodo_editor ("VRAM optimized", 1),
  MasterYip/KimodoLocoMoGen (robot locomotion batch generation). READMEs of most are the upstream copy or unread.
