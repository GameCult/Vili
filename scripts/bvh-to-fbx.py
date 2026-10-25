# Converts one Kimodo standard-T-pose BVH to one FBX. Blender converts formats and nothing else: no retarget, no
# rename, no key reduction, no resample, no root-motion bake. It applies the frame range it is handed and chooses
# none: the whole take unless the daemon passes --frames. Run by the daemon (scripts/vili-daemon.mjs exportClip):
#   blender -b --factory-startup --python-use-system-env --python-exit-code 1 --python bvh-to-fbx.py -- <bvh> <fbx> <clipName> [--frames <A> <B>]
# Frames are Blender's, counted from 1: the BVH's frame k is Blender's k + 1. Exit 3 is an argument or a hash seed it
# will not take, exit 4 a range outside the take.
# with PYTHONHASHSEED=0 in the environment. The settings are Blender API parameters, cross-checked against the
# 'unity' preset of wifimetas/kimodo-mcp blender_export.py (Apache-2.0, 83b5361); no code is copied.
import datetime
import json
import sys
import types

import bpy

# io_scene_fbx hashes strings for UUIDs (fbx_utils.py) and stamps the file with now() (export_fbx_bin.py): a fixed
# hash seed and a fixed time make one BVH on one host body give one set of FBX bytes.
if sys.flags.hash_randomization != 0:
    sys.exit(3)

bvh, fbx, clip, *window = sys.argv[sys.argv.index("--") + 1:]
if window and not (len(window) == 3 and window[0] == "--frames" and all(arg.isdigit() for arg in window[1:])):
    sys.exit(3)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0

import io_scene_fbx.export_fbx_bin as fbx_bin  # after the factory reset, which the pin must outlive

if not hasattr(fbx_bin, "datetime"):
    raise RuntimeError("io_scene_fbx.export_fbx_bin no longer stamps with datetime: the pin must move")
fixed_time = datetime.datetime(1970, 1, 1)
fbx_bin.datetime = types.SimpleNamespace(datetime=types.SimpleNamespace(now=lambda: fixed_time))

bpy.ops.import_anim.bvh(
    filepath=bvh, global_scale=0.01, axis_forward="-Z", axis_up="Y", rotate_mode="NATIVE",
    use_fps_scale=False, update_scene_fps=True, frame_start=1,
)
armature = bpy.context.view_layer.objects.active
action = armature.animation_data.action
# The FBX take takes the scene's name.
armature.name = armature.data.name = action.name = scene.name = clip
first, last = (int(frame) for frame in action.frame_range)
if window:
    first, last = int(window[1]), int(window[2])
    if not (int(action.frame_range[0]) <= first < last <= int(action.frame_range[1])):
        sys.exit(4)
scene.frame_start, scene.frame_end = first, last

bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
bpy.ops.export_scene.fbx(
    filepath=fbx, use_selection=True, object_types={"ARMATURE"}, apply_unit_scale=True,
    apply_scale_options="FBX_SCALE_ALL", axis_forward="-Z", axis_up="Y", add_leaf_bones=False,
    primary_bone_axis="Y", secondary_bone_axis="X", armature_nodetype="NULL", bake_anim=True,
    bake_anim_use_all_bones=True, bake_anim_use_nla_strips=False, bake_anim_use_all_actions=False,
    bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
)
print("VILI-FBX " + json.dumps({"bones": len(armature.data.bones), "frames": [first, last], "fps": scene.render.fps}))
