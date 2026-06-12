#!/usr/bin/env python3
import argparse
import json
import os
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from types import SimpleNamespace

import torch

from kimodo import DEFAULT_MODEL, load_model
from kimodo.constraints import load_constraints_lst
from kimodo.exports.motion_io import save_kimodo_npz
from kimodo.model.registry import get_model_info
from kimodo.scripts.generate import (
    _output_dir_and_path,
    _single_file_path,
    get_texts_and_num_frames_from_prompt,
    resolve_cfg_kwargs,
)
from kimodo.tools import seed_everything


def parse_args():
    parser = argparse.ArgumentParser(description="Resident Vili worker for Kimodo motion generation")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8825)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    return parser.parse_args()


args = parse_args()
device = "cuda:0" if torch.cuda.is_available() else "cpu"
started_at = time.time()
model_load_started_at = time.time()
model, resolved_model = load_model(
    args.model,
    device=device,
    default_family="Kimodo",
    return_resolved_name=True,
)
model_load_seconds = time.time() - model_load_started_at
model_info = get_model_info(resolved_model)
display_model = model_info.display_name if model_info else resolved_model
generation_lock = Lock()
generation_count = 0


def write_json(handler, status_code, payload):
    body = json.dumps(payload, indent=2).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("cache-control", "no-store")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def request_bool(payload, name, default=False):
    value = payload.get(name, default)
    return value is True or str(value).lower() in ("1", "true", "yes", "on")


def save_outputs(output, output_base, export_bvh, bvh_standard_tpose):
    files = []
    n_samples = int(output["posed_joints"].shape[0])

    if n_samples == 1:
        npz_path = _single_file_path(output_base, ".npz")
        single = {
            k: (v[0] if hasattr(v, "shape") and len(v.shape) > 0 and v.shape[0] == n_samples else v)
            for k, v in output.items()
        }
        save_kimodo_npz(npz_path, single)
        files.append(npz_path)
    else:
        out_dir, _, base_name = _output_dir_and_path(output_base, "motion", ".npz")
        for index in range(n_samples):
            single = {
                k: (v[index] if hasattr(v, "shape") and len(v.shape) > 0 and v.shape[0] == n_samples else v)
                for k, v in output.items()
            }
            npz_path = os.path.join(out_dir, f"{base_name}_{index:02d}.npz")
            save_kimodo_npz(npz_path, single)
            files.append(npz_path)

    if export_bvh:
        skeleton = model.skeleton
        if "somaskel" in skeleton.name:
            from kimodo.exports.bvh import save_motion_bvh
            from kimodo.skeleton import SOMASkeleton30, global_rots_to_local_rots

            if isinstance(skeleton, SOMASkeleton30):
                skeleton = skeleton.somaskel77.to(device)

            if n_samples == 1:
                bvh_path = _single_file_path(output_base, ".bvh")
                joints_pos = torch.from_numpy(output["posed_joints"][0]).to(device)
                joints_rot = torch.from_numpy(output["global_rot_mats"][0]).to(device)
                local_rot_mats = global_rots_to_local_rots(joints_rot, skeleton)
                root_positions = joints_pos[:, skeleton.root_idx, :]
                save_motion_bvh(
                    bvh_path,
                    local_rot_mats,
                    root_positions,
                    skeleton=skeleton,
                    fps=model.fps,
                    standard_tpose=bvh_standard_tpose,
                )
                files.append(bvh_path)
            else:
                out_dir, _, base_name = _output_dir_and_path(output_base, "motion", ".bvh")
                for index in range(n_samples):
                    bvh_path = os.path.join(out_dir, f"{base_name}_{index:02d}.bvh")
                    joints_pos = torch.from_numpy(output["posed_joints"][index]).to(device)
                    joints_rot = torch.from_numpy(output["global_rot_mats"][index]).to(device)
                    local_rot_mats = global_rots_to_local_rots(joints_rot, skeleton)
                    root_positions = joints_pos[:, skeleton.root_idx, :]
                    save_motion_bvh(
                        bvh_path,
                        local_rot_mats,
                        root_positions,
                        skeleton=skeleton,
                        fps=model.fps,
                        standard_tpose=bvh_standard_tpose,
                    )
                    files.append(bvh_path)

    return files


def generate(payload):
    global generation_count

    prompt = str(payload.get("prompt") or payload.get("utterance") or "").strip()
    if not prompt:
        raise ValueError("Missing prompt or utterance.")

    output_base = str(payload.get("output") or "/outputs/motion")
    duration = str(payload.get("durationSeconds") or payload.get("duration") or 4)
    diffusion_steps = max(1, int(payload.get("diffusionSteps") or payload.get("diffusion_steps") or 20))
    num_samples = max(1, int(payload.get("numSamples") or payload.get("num_samples") or 1))
    num_transition_frames = int(payload.get("numTransitionFrames") or payload.get("num_transition_frames") or 5)
    constraints_path = payload.get("constraints")
    seed = payload.get("seed")
    seed = int(seed) if seed is not None else None

    texts, num_frames = get_texts_and_num_frames_from_prompt(prompt, duration, model.fps)
    constraint_lst = load_constraints_lst(constraints_path, model.skeleton) if constraints_path else []
    if seed is not None:
        seed_everything(seed)

    cfg_meta = {"cfg": payload["cfg"]} if isinstance(payload.get("cfg"), dict) else None
    cfg_namespace = SimpleNamespace()
    if "cfgType" in payload or "cfg_type" in payload:
        cfg_namespace.cfg_type = payload.get("cfgType") or payload.get("cfg_type")
    if "cfgWeight" in payload or "cfg_weight" in payload:
        weight = payload.get("cfgWeight") if "cfgWeight" in payload else payload.get("cfg_weight")
        cfg_namespace.cfg_weight = weight if isinstance(weight, list) else [weight]
    cfg_kwargs = resolve_cfg_kwargs(cfg_namespace, cfg_meta)

    use_postprocess = False if "g1" in resolved_model else (not request_bool(payload, "noPostprocess"))
    started = time.time()
    with generation_lock:
        locked_at = time.time()
        output = model(
            texts,
            num_frames,
            constraint_lst=constraint_lst,
            num_denoising_steps=diffusion_steps,
            num_samples=num_samples,
            multi_prompt=True,
            num_transition_frames=num_transition_frames,
            post_processing=use_postprocess,
            return_numpy=True,
            **cfg_kwargs,
        )
        files = save_outputs(
            output,
            output_base,
            request_bool(payload, "bvh"),
            request_bool(payload, "bvhStandardTpose") or request_bool(payload, "bvh_standard_tpose"),
        )
        generation_count += 1

    finished = time.time()
    clip_seconds = sum(frame_count / model.fps for frame_count in num_frames)
    return {
        "ok": True,
        "model": resolved_model,
        "displayModel": display_model,
        "device": device,
        "fps": model.fps,
        "texts": texts,
        "numFrames": num_frames,
        "clipSeconds": clip_seconds,
        "diffusionSteps": diffusion_steps,
        "numSamples": num_samples,
        "seed": seed,
        "files": files,
        "timing": {
            "queueSeconds": locked_at - started,
            "generationSeconds": finished - locked_at,
            "wallSeconds": finished - started,
            "realtimeMultiplier": clip_seconds / (finished - started) if finished > started else 0,
            "generationCount": generation_count,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            write_json(self, 404, {"ok": False, "error": "not found"})
            return
        write_json(self, 200, {
            "ok": True,
            "schema": "gamecult.vili.kimodo_worker.v0",
            "device": device,
            "model": resolved_model,
            "displayModel": display_model,
            "fps": model.fps,
            "startedAtEpoch": started_at,
            "uptimeSeconds": time.time() - started_at,
            "modelLoadSeconds": model_load_seconds,
            "generationCount": generation_count,
        })

    def do_POST(self):
        if self.path != "/generate":
            write_json(self, 404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            write_json(self, 200, generate(payload))
        except Exception as error:
            write_json(self, 500, {
                "ok": False,
                "error": str(error),
                "traceback": traceback.format_exc(),
            })

    def log_message(self, fmt, *values):
        print(f"{self.address_string()} - {fmt % values}", flush=True)


print(json.dumps({
    "event": "kimodo-worker-ready",
    "device": device,
    "model": resolved_model,
    "displayModel": display_model,
    "modelLoadSeconds": model_load_seconds,
    "port": args.port,
}), flush=True)
ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
