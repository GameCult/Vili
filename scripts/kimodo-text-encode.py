#!/usr/bin/env python3
"""One-shot Kimodo text encoder: texts on stdin, vectors in --out, then exit so the OS reclaims its RAM.

Reads {"texts": [...]} as JSON on stdin. Loads LLM2Vec assembly B on CPU in bfloat16, encodes each text alone as
LLM2VecEncoder does, and writes a MessagePack answer. The torch thread budget is VILI_THREADS.
"""
import json
import os
import resource
import sys
import time
from pathlib import Path

import msgpack
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from text_encoding import ASSEMBLY, EMBEDDING_DIM, LLAMA_BASE, apply_thread_cap  # noqa: E402

from peft import PeftModel  # noqa: E402
from transformers import AutoConfig, AutoTokenizer  # noqa: E402

from kimodo.model.llm2vec.llm2vec import LLM2Vec  # noqa: E402
from kimodo.model.load_model import TEXT_ENCODER_PRESETS  # noqa: E402


def load_encoder(mntp_id, supervised_id, dtype):
    """Assembly B: the Llama base with the MNTP adapter merged in, then the supervised adapter on top.

    Kimodo's own LLM2VecEncoder loads the MNTP repo as the base and never applies the MNTP weights under the
    pinned transformers (assembly A); this assembly is ours (motion-pipeline:ruling:encoder-assembly-b). The
    identity carries the Kimodo commit and this file's sha256, so a changed loader misses the cache.
    """
    tokenizer = AutoTokenizer.from_pretrained(LLAMA_BASE)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    model_class = LLM2Vec._get_model_class(AutoConfig.from_pretrained(LLAMA_BASE).__class__.__name__, enable_bidirectional=True)
    model = model_class.from_pretrained(LLAMA_BASE, torch_dtype=dtype)
    model = PeftModel.from_pretrained(model, mntp_id).merge_and_unload()
    model = PeftModel.from_pretrained(model, supervised_id)
    return LLM2Vec(model=model, tokenizer=tokenizer)


def main() -> int:
    apply_thread_cap(os.environ)
    texts = json.load(sys.stdin)["texts"]
    out = Path(sys.argv[sys.argv.index("--out") + 1])
    preset = TEXT_ENCODER_PRESETS["llm2vec"]["kwargs"]

    started = time.perf_counter()
    model = load_encoder(preset["base_model_name_or_path"], preset["peft_model_name_or_path"], getattr(torch, preset["dtype"]))
    model.eval()
    for p in model.parameters():
        p.requires_grad = False
    load_seconds = time.perf_counter() - started

    vectors, encode_seconds = [], []
    for text in texts:
        began = time.perf_counter()
        features = model.tokenize([model.prepare_for_tokenization(model._convert_to_str("", text))])
        with torch.no_grad():
            vector = model.forward(features).detach().cpu().to(torch.float32)[0]
        assert vector.shape == (EMBEDDING_DIM,)
        vectors.append(vector.numpy().tobytes())
        encode_seconds.append(time.perf_counter() - began)

    out.write_bytes(msgpack.packb({
        "vectors": vectors,
        "encodeSeconds": encode_seconds,
        "loadSeconds": load_seconds,
        "placement": {"cpuBytes": sum(p.numel() * p.element_size() for p in model.parameters())},
        "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        "device": "cpu",
        "assembly": ASSEMBLY,
    }, use_bin_type=True))
    return 0


sys.exit(main())
