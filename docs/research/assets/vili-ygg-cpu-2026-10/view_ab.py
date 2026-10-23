# Side-by-side A/B viewer for the encoder eye check (docs/research/vili-on-yggdrasil-cpu-2026-10.md).
# Usage, from the repo root:
#   blender --factory-startup --python docs/research/assets/vili-ygg-cpu-2026-10/view_ab.py -- rock
# (prompt is rock, paper or victory). A (today's Vili vectors, no MNTP) stands on the left at x = -1 m,
# B (MNTP merged, LLM2Vec's design) on the right at x = +1 m. Same seed (7), same denoiser (Kimodo-SOMA-RP-v1.1).
import os
import sys

import bpy

prompt = (sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "rock")
here = os.path.dirname(os.path.abspath(__file__))
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
for tag, x in (("A", -1.0), ("B", 1.0)):
    path = os.path.join(here, f"v1.1_{tag}_{prompt}_3s.bvh")
    bpy.ops.import_anim.bvh(filepath=path, global_scale=0.01, axis_forward="-Z", axis_up="Y", rotate_mode="NATIVE",
                            use_fps_scale=False, update_scene_fps=True, frame_start=1)
    obj = bpy.context.selected_objects[0]
    obj.name = f"{tag}_{prompt}"
    obj.location.x = x
    obj.show_name = True
    obj.data.display_type = "STICK"
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 90
scene.render.fps = 30
if bpy.context.screen and not bpy.app.background:
    bpy.ops.screen.animation_play()
print("view_ab", prompt, [(o.name, len(o.data.bones), tuple(o.location)) for o in bpy.data.objects])
