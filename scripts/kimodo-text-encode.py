#!/usr/bin/env python3
"""One-shot Kimodo text encoder: texts on stdin, vectors in --out, then exit so the OS reclaims RAM and VRAM.

Reads {"texts": [...]} as JSON on stdin. Loads Kimodo's LLM2Vec preset in bfloat16 with the layers that do not
fit in free VRAM held in RAM, encodes each text alone as LLM2VecEncoder does, and writes a MessagePack answer.
There is no CPU fallback; --device cpu exists only for the reference probe.
"""
import argparse
import json
import resource
import sys
import time
from pathlib import Path

import msgpack
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_encoding import CHILD_EXIT_GPU_BUSY, EMBEDDING_DIM, GpuBusy, plan_placement  # noqa: E402

from peft import PeftModel  # noqa: E402
from transformers import AutoConfig, AutoTokenizer  # noqa: E402

from kimodo.model.llm2vec.llm2vec import LLM2Vec, batch_to_device  # noqa: E402
from kimodo.model.load_model import TEXT_ENCODER_PRESETS  # noqa: E402


def load_encoder(base_id, peft_id, dtype, peft_kwargs, **model_kwargs):
    """Assemble the encoder in the order and with the ids of LLM2Vec.from_pretrained.

    MUST TRACK Kimodo's loader: kimodo/model/llm2vec/llm2vec.py, LLM2Vec.from_pretrained, Kimodo commit 6bb5848
    (nv-tlabs/kimodo). It is mirrored, not called, because that method hands PeftModel.from_pretrained no kwargs, and
    with layers offloaded to RAM peft then takes a path that raises TypeError in accelerate's get_balanced_memory
    (peft 0.18.1, accelerate 1.13.0, transformers 5.1.0). Here every PeftModel.from_pretrained gets peft_kwargs
    (device_map='sequential'). Operator ruling motion-pipeline:ruling:encoder-own-loader. The ids' llm2vec_config.json
    is not a local path, so Kimodo's loader applies no encoder config; neither does this.
    """
    tokenizer = AutoTokenizer.from_pretrained(base_id)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    model_class = LLM2Vec._get_model_class(AutoConfig.from_pretrained(base_id).__class__.__name__, enable_bidirectional=True)
    model = model_class.from_pretrained(base_id, torch_dtype=dtype, **model_kwargs)
    if hasattr(model, "peft_config"):
        model = PeftModel.from_pretrained(model, base_id, **peft_kwargs).merge_and_unload()
    model = PeftModel.from_pretrained(model, peft_id, **peft_kwargs)
    return LLM2Vec(model=model, tokenizer=tokenizer)


def mem_available() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    raise RuntimeError("MemAvailable is not in /proc/meminfo")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--device", choices=["gpu", "cpu"], default="gpu")
    args = parser.parse_args()
    texts = json.load(sys.stdin)["texts"]
    preset = TEXT_ENCODER_PRESETS["llm2vec"]["kwargs"]

    load_kwargs, peft_kwargs = {}, {}
    if args.device == "gpu":
        free_vram, _ = torch.cuda.mem_get_info(0)
        try:
            max_memory = plan_placement(free_vram, mem_available())
            load_kwargs = {"device_map": "auto", "max_memory": max_memory}
            peft_kwargs = {"device_map": "sequential", "max_memory": max_memory}
        except GpuBusy as busy:
            Path(args.out).write_bytes(msgpack.packb({"error": busy.code, "freeVramBytes": busy.free_vram}, use_bin_type=True))
            return CHILD_EXIT_GPU_BUSY

    started = time.perf_counter()
    model = load_encoder(
        preset["base_model_name_or_path"],
        preset["peft_model_name_or_path"],
        getattr(torch, preset["dtype"]),
        peft_kwargs,
        **load_kwargs,
    )
    model.eval()
    for p in model.parameters():
        p.requires_grad = False
    load_seconds = time.perf_counter() - started

    placement = {"gpuBytes": 0, "cpuBytes": 0}
    for p in model.parameters():
        placement["gpuBytes" if p.device.type == "cuda" else "cpuBytes"] += p.numel() * p.element_size()
    input_device = "cuda:0" if args.device == "gpu" else "cpu"

    vectors, encode_seconds = [], []
    for text in texts:
        began = time.perf_counter()
        # The path LLM2Vec.encode takes for one text, without its .to(device) that would undo the device map.
        features = model.tokenize([model.prepare_for_tokenization(model._convert_to_str("", text))])
        features = batch_to_device(features, input_device)
        with torch.no_grad():
            vector = model.forward(features).detach().cpu().to(torch.float32)[0]
        assert vector.shape == (EMBEDDING_DIM,)
        vectors.append(vector.numpy().tobytes())
        encode_seconds.append(time.perf_counter() - began)

    Path(args.out).write_bytes(msgpack.packb({
        "vectors": vectors,
        "encodeSeconds": encode_seconds,
        "loadSeconds": load_seconds,
        "placement": placement,
        "peakVramBytes": torch.cuda.max_memory_allocated(0) if torch.cuda.is_available() else 0,
        "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        "device": args.device,
    }, use_bin_type=True))
    return 0


sys.exit(main())
