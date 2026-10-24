"""Runs scripts/bvh-to-fbx.py in the real Blender the daemon runs (VILI_BLENDER), with the environment the daemon
builds for it (scripts/vili-daemon.mjs exportEnv). The recipe's test-worker step runs this against the unpacked
blender tree; there is no skip: without VILI_BLENDER it errors.

    VILI_BLENDER=<blender> python3.12 -m unittest scripts/test_bvh_to_fbx.py
"""
import importlib.util
import json
import os
import pathlib
import re
import struct
import subprocess
import tempfile
import unittest

BLENDER = os.environ["VILI_BLENDER"]
SCRIPT = pathlib.Path(__file__).resolve().with_name("bvh-to-fbx.py")

# Reads an FBX back into a factory scene and reports what the avatar cut will see. With a BVH as its second
# argument it also imports that BVH the way Blender itself does (native Euler order), as the reference pose.
INSPECT = r'''
import bpy, json, sys
argv = sys.argv[sys.argv.index("--") + 1:]
fbx = argv[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
scene = bpy.context.scene
arm = next(o for o in scene.objects if o.type == "ARMATURE")

def world(name, frame):
    scene.frame_set(frame)
    return (arm.matrix_world @ arm.pose.bones[name].matrix).translation.copy()

out = {
    "bones": [b.name for b in arm.data.bones],
    "scale": list(arm.scale),
    "hips_rest": arm.data.bones["Hips"].head_local.z * arm.scale.z,
}
action = arm.animation_data.action if arm.animation_data else None
if action is not None:
    out["action"] = action.name
    first, last = (int(f) for f in action.frame_range)
    out["frame_range"] = [first, last]
    # The importer starts the take a frame late: sample i is at frame first + 1 + i, and the range ends before the
    # last key. Read two frames past it.
    frames = range(first, last + 3)
    out["hips_travel"] = max((world("Hips", f) - world("Hips", first)).length for f in frames)
    out["hips_mid"] = (world("Hips", first + 1 + 15) - world("Hips", first)).length
    out["root_wander"] = max((world("Root", f) - world("Root", first)).length for f in frames)
    out["head_from_hips"] = list(world("Head", first + 1 + 15) - world("Hips", first + 1 + 15))
    if len(argv) > 1:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_anim.bvh(filepath=argv[1], global_scale=0.01, axis_forward="-Z", axis_up="Y", rotate_mode="NATIVE",
                                use_fps_scale=False, update_scene_fps=True, frame_start=1)
        scene = bpy.context.scene
        arm = bpy.context.view_layer.objects.active
        out["reference_head_from_hips"] = list(world("Head", 1 + 15) - world("Hips", 1 + 15))
print("INSPECT " + json.dumps(out))
'''


def export_env():
    env = {
        "HOME": "/nonexistent",
        "PYTHONHASHSEED": "0",
        "PYTHONNOUSERSITE": "1",
        "LD_LIBRARY_PATH": os.path.join(os.path.dirname(BLENDER), "lib"),
    }
    for name in ("PATH", "LANG"):
        if name in os.environ:
            env[name] = os.environ[name]
    return env


def blender(*argv, env=None):
    return subprocess.run(
        [BLENDER, "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1", *argv],
        env=export_env() if env is None else env, capture_output=True, text=True, timeout=600,
    )


def convert(bvh, fbx, clip, env=None):
    return blender("--python", str(SCRIPT), "--", str(bvh), str(fbx), clip, env=env)


def result(run):
    line = next(line for line in run.stdout.splitlines() if line.startswith("VILI-FBX "))
    return json.loads(line[len("VILI-FBX "):])


def unit_scale_factor(fbx):
    """GlobalSettings' UnitScaleFactor from a binary FBX: the property is four strings, then a double."""
    raw = pathlib.Path(fbx).read_bytes()
    position = raw.index(b"UnitScaleFactor") + len(b"UnitScaleFactor")
    for _ in range(3):  # type "double", label "Number", flags ""
        assert raw[position:position + 1] == b"S"
        position += 5 + struct.unpack("<I", raw[position + 1:position + 5])[0]
    assert raw[position:position + 1] == b"D"
    return struct.unpack("<d", raw[position + 1:position + 9])[0]


def rest_bvh():
    spec = importlib.util.find_spec("kimodo")
    return pathlib.Path(spec.submodule_search_locations[0]) / "assets" / "skeletons" / "somaskel77" / "somaskel77_standard_tpose.bvh"


class BvhToFbx(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = pathlib.Path(cls.tmp.name)
        cls.rest = rest_bvh()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def inspect(self, fbx, bvh=None):
        script = self.dir / "inspect.py"
        script.write_text(INSPECT)
        run = blender("--python", str(script), "--", str(fbx), *([str(bvh)] if bvh else []))
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        line = next(line for line in run.stdout.splitlines() if line.startswith("INSPECT "))
        return json.loads(line[len("INSPECT "):])

    def test_rest_pose_keeps_the_bvh_joint_names_and_height(self):
        fbx = self.dir / "rest.fbx"
        run = convert(self.rest, fbx, "SOMA77_Rest")
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        self.assertEqual(result(run), {"bones": 78, "frames": [1, 1], "fps": 30})
        joints = re.findall(r"^\s*(?:ROOT|JOINT)\s+(\S+)", self.rest.read_text(), re.M)
        seen = self.inspect(fbx)
        self.assertEqual(len(joints), 78)
        self.assertEqual(sorted(seen["bones"]), sorted(joints))
        self.assertFalse(any("mixamorig" in name for name in seen["bones"]))
        for axis in seen["scale"]:
            self.assertAlmostEqual(axis, 1.0, places=4)
        self.assertAlmostEqual(seen["hips_rest"], 1.0, delta=0.01)
        self.assertEqual(unit_scale_factor(fbx), 100.0, "the file says its unit is the metre")

    def test_two_exports_of_one_bvh_are_byte_identical(self):
        first, second = self.dir / "a.fbx", self.dir / "b.fbx"
        for target in (first, second):
            self.assertEqual(convert(self.rest, target, "twin").returncode, 0)
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_without_a_fixed_hash_seed_the_script_exits_3(self):
        env = export_env()
        del env["PYTHONHASHSEED"]
        target = self.dir / "unseeded.fbx"
        self.assertEqual(convert(self.rest, target, "unseeded", env=env).returncode, 3)
        self.assertFalse(target.exists())

    def test_a_clip_keeps_its_travel_timing_pose_and_name(self):
        text = self.rest.read_text()
        header = text[:text.index("MOTION")]
        channels = sum(int(n) for n in re.findall(r"CHANNELS\s+(\d+)", header))
        frames = 31
        rows = []
        for frame in range(frames):
            row = ["0"] * channels
            row[8] = repr(100.0 * (frame / (frames - 1)) ** 2)  # Hips Zposition, cm: one metre, accelerating
            row[12], row[13], row[14] = "30", "20", "40"  # Spine1 Z, Y, X rotation: the Euler order matters
            rows.append(" ".join(row))
        bvh = self.dir / "walk.bvh"
        bvh.write_text(f"{header}MOTION\nFrames: {frames}\nFrame Time: 0.0333333\n" + "\n".join(rows) + "\n")
        fbx = self.dir / "walk.fbx"
        run = convert(bvh, fbx, "walk")
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        self.assertEqual(result(run), {"bones": 78, "frames": [1, frames], "fps": 30})
        seen = self.inspect(fbx, bvh)
        self.assertIn("walk", seen["action"], "the clip name reaches the FBX take")
        self.assertGreaterEqual(seen["frame_range"][1], frames, "the take keeps the whole clip")
        self.assertLessEqual(seen["frame_range"][1], frames + 2, "the take is not the scene's default range")
        self.assertAlmostEqual(seen["hips_travel"], 1.0, delta=0.001, msg=json.dumps(seen))
        self.assertAlmostEqual(seen["hips_mid"], 0.25, delta=0.002, msg="every key is kept, none simplified away")
        self.assertLess(seen["root_wander"], 1e-4)
        for got, want in zip(seen["head_from_hips"], seen["reference_head_from_hips"]):
            self.assertAlmostEqual(got, want, delta=0.002, msg="the rotated pose is Blender's own native reading of the BVH")


if __name__ == "__main__":
    unittest.main()
