"""The frame window of a generated take that loops with the smallest seam. Called by the resident worker, nowhere else.

A seam is the jump from frame b back to frame a. Its cost is the pose difference plus 0.1 s times the velocity
difference (Kovar, Gleicher and Pighin 2002, motion-graph transitions), both as RMS over joints, with each frame
taken relative to its own Hips and turned to face a fixed way, so where the take wanders and which way it faces
do not count. Numpy only.
"""
import numpy as np

VELOCITY_WEIGHT_SECONDS = 0.1


def loop_window(joints, heading, fps, min_frames, hips=0):
    """joints [F, J, 3] world positions, heading [F] radians about Y (Kimodo's hip-vector angle), the joint index of
    Hips. Returns (first, last, pose_cost, velocity_cost): frame indices into the take, last inclusive, last - first
    at least min_frames, the pair with the lowest cost. A tie goes to the longer window, then to the earlier first."""
    joints = np.asarray(joints, dtype=np.float64)
    heading = np.asarray(heading, dtype=np.float64)
    frames = joints.shape[0]
    if joints.ndim != 3 or joints.shape[2] != 3 or heading.shape != (frames,) or not 1 <= min_frames < frames:
        raise ValueError("loop_window: shapes or min_frames out of range")
    relative = joints - joints[:, hips:hips + 1]
    cos, sin = np.cos(-heading), np.sin(-heading)
    x, z = relative[..., 0], relative[..., 2]
    pose = relative.copy()
    pose[..., 0] = x * cos[:, None] + z * sin[:, None]
    pose[..., 2] = -x * sin[:, None] + z * cos[:, None]
    velocity = np.gradient(pose, axis=0) * fps  # central differences, one-sided at the two ends

    firsts, lasts = np.triu_indices(frames, k=min_frames)
    pose_cost = np.empty(len(firsts))
    velocity_cost = np.empty(len(firsts))
    for first in range(frames - min_frames):  # one row of seams at a time: memory stays O(frames * joints)
        row = slice(*np.searchsorted(firsts, [first, first + 1]))
        later = lasts[row]
        pose_cost[row] = np.sqrt(((pose[later] - pose[first]) ** 2).sum(-1).mean(-1))
        velocity_cost[row] = np.sqrt(((velocity[later] - velocity[first]) ** 2).sum(-1).mean(-1))
    cost = pose_cost + VELOCITY_WEIGHT_SECONDS * velocity_cost
    best = np.flatnonzero(cost == cost.min())
    pick = best[np.lexsort((firsts[best], -(lasts[best] - firsts[best])))[0]]
    return int(firsts[pick]), int(lasts[pick]), float(pose_cost[pick]), float(velocity_cost[pick])
