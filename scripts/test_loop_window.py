"""python3 -m unittest scripts/test_loop_window.py   (numpy only)"""
import math
import pathlib
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from loop_window import loop_window  # noqa: E402

FPS = 30


def turn(points, angle):
    """Rotate points [..., 3] about Y by angle, so that +Z turns toward +X (Kimodo's heading: 0 faces +Z)."""
    x, z = points[..., 0], points[..., 2]
    out = points.copy()
    out[..., 0] = x * math.cos(angle) + z * math.sin(angle)
    out[..., 2] = -x * math.sin(angle) + z * math.cos(angle)
    return out


def stride(frames=240, period=37, start=40, end=200):
    """A stride cycle between two different rests. Hips travels; every other joint swings."""
    rng = np.random.default_rng(3)
    rest_a, rest_b = rng.normal(size=(2, 6, 3)) * 0.3
    phase, direction = rng.uniform(0, 6.28, 6), rng.normal(size=(6, 3))
    out = np.zeros((frames, 7, 3))
    for f in range(frames):
        weight = min(1.0, f / start, (frames - 1 - f) / (frames - 1 - end))
        rest = rest_a if f < frames // 2 else rest_b
        cycle = 0.2 * np.sin(2 * math.pi * f / period + phase)[:, None] * direction
        out[f, 1:] = weight * (rest_a + cycle) + (1 - weight) * rest
        out[f, 0] = (0.03 * f, 0.9, 0.0)  # Hips
        out[f, 1:] += out[f, 0]
    return out


def reference(joints, heading, fps, min_frames):
    """The cost written out frame by frame and joint by joint, to check the vectorised search against."""
    frames, count = joints.shape[0], joints.shape[1]
    pose = np.zeros((frames, count, 3))
    for f in range(frames):
        pose[f] = turn(joints[f] - joints[f, 0], -heading[f])
    velocity = np.zeros_like(pose)
    for f in range(frames):
        lo, hi = max(f - 1, 0), min(f + 1, frames - 1)
        velocity[f] = (pose[hi] - pose[lo]) / (hi - lo) * fps
    best = None
    for a in range(frames):
        for b in range(a + min_frames, frames):
            p = math.sqrt(sum(np.sum((pose[b, j] - pose[a, j]) ** 2) for j in range(count)) / count)
            v = math.sqrt(sum(np.sum((velocity[b, j] - velocity[a, j]) ** 2) for j in range(count)) / count)
            cost = p + 0.1 * v
            key = (cost, -(b - a), a)
            if best is None or key < best[0]:
                best = (key, a, b, p, v)
    return best[1:]


def wandering(frames=44, count=4, seed=0):
    """A smooth, unrepeating motion that turns as it goes, so the best window is unique and pose, velocity and
    heading each move it."""
    rng = np.random.default_rng(seed)
    time = np.arange(frames)
    joints = sum(rng.normal(size=(1, count, 3)) * 0.3 * np.sin(time[:, None, None] * rng.uniform(0.05, 0.5) + rng.uniform(0, 6.28))
                 for _ in range(4))
    heading = sum(0.4 * np.sin(time * rng.uniform(0.03, 0.2) + rng.uniform(0, 6.28)) for _ in range(2))
    return joints, heading


class LoopWindow(unittest.TestCase):
    def test_a_periodic_motion_between_rest_ramps(self):
        joints = stride()
        first, last, pose_cost, _ = loop_window(joints, np.zeros(240), FPS, 120)
        self.assertGreaterEqual(first, 40)
        self.assertLessEqual(last, 200)
        self.assertEqual((last - first) % 37, 0, (first, last))
        self.assertGreaterEqual(last - first, 120)
        self.assertLess(pose_cost, 1e-3)
        self.assertNotEqual((first, last), (0, 239), "the whole take is not the answer")

    def test_the_search_is_the_stated_cost(self):
        joints, heading = wandering()
        want_first, want_last, want_pose, want_velocity = reference(joints, heading, FPS, 22)
        got = loop_window(joints, heading, FPS, 22)
        self.assertEqual(got[:2], (want_first, want_last))
        self.assertAlmostEqual(got[2], want_pose, places=9)
        self.assertAlmostEqual(got[3], want_velocity, places=9)
        # The velocity term decides here: matching poses alone would pick another window.
        pose_only = min(
            ((np.sqrt(((turn(joints[b] - joints[b, 0], -heading[b]) - turn(joints[a] - joints[a, 0], -heading[a])) ** 2).sum(-1).mean()), a, b)
             for a in range(44) for b in range(a + 22, 44)))
        self.assertNotEqual(pose_only[1:], (want_first, want_last))

    def test_heading_is_normalised_away(self):
        joints, heading = wandering()
        upright = np.stack([turn(joints[f] - joints[f, :1], -heading[f]) + joints[f, :1] for f in range(44)])
        turned = np.stack([turn(upright[f] - upright[f, :1], heading[f]) + upright[f, :1] for f in range(44)])
        want = loop_window(upright, np.zeros(44), FPS, 22)
        got = loop_window(turned, heading, FPS, 22)
        self.assertEqual(got[:2], want[:2])
        self.assertAlmostEqual(got[2], want[2], places=9)
        self.assertNotEqual(loop_window(turned, np.zeros(44), FPS, 22)[:2], want[:2], "the turning would otherwise change the answer")

    def test_a_tie_goes_to_the_longer_window_then_the_earlier(self):
        cycle = np.array([[0, 0, 0], [0.5, 0.2, 0.1], [0.2, 0.7, 0.3], [0.4, 0.1, 0.9]], dtype=float)
        joints = np.stack([np.stack([np.zeros(3), cycle[f % 4]]) for f in range(30)])
        # Exact repeats every 4 frames: every a, b with b - a a multiple of 4 inside 1..28 costs zero.
        self.assertEqual(loop_window(joints, np.zeros(30), FPS, 15)[:2], (1, 25))
        still = np.zeros((30, 3, 3))
        self.assertEqual(loop_window(still, np.zeros(30), FPS, 15)[:2], (0, 29))

    def test_no_window_is_shorter_than_the_minimum(self):
        joints, heading = wandering(frames=31)
        for minimum in (5, 16, 25):
            first, last, _, _ = loop_window(joints, heading, FPS, minimum)
            self.assertGreaterEqual(last - first, minimum)
        self.assertEqual(loop_window(joints, heading, FPS, 30)[:2], (0, 30))

    def test_hips_is_the_joint_it_is_told(self):
        joints, heading = wandering()
        moved = joints[:, [2, 0, 1, 3]]
        self.assertEqual(loop_window(moved, heading, FPS, 22, hips=1), loop_window(joints, heading, FPS, 22, hips=0))

    def test_shapes_and_minimum_are_checked_without_echoing_them(self):
        joints, heading = wandering()
        for bad in ((joints, heading[:-1], 22), (joints, heading, 0), (joints, heading, 4321), (joints[..., :2], heading, 22)):
            with self.assertRaises(ValueError) as caught:
                loop_window(bad[0], bad[1], FPS, bad[2])
            self.assertNotIn("4321", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
