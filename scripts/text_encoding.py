"""Text-embedding cache and transient-encoder contract for Vili's resident Kimodo worker.

The worker never holds the 8B text encoder. CachedTextEncoder answers Kimodo's
encoder call from a CultCache store of float32 vectors and sends only the
missing texts to kimodo-text-encode.py, a one-shot child that loads the encoder,
encodes, writes its answer to a file and exits. Nothing here logs or raises with
a prompt in it: an error names a count, a size or a rule, never a text.
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import msgpack
import torch

from cultcache_py import CultCache, SingleFileMessagePackBackingStore, define_database_entry_type, database_entry_field, leaves as t

GIB = 1024 ** 3
MIN_FREE_VRAM = 2 * GIB
GPU_RESERVE = int(3 * GIB)  # headroom for activations and offloaded layers streamed through the card
CPU_RESERVE = int(1.5 * GIB)
EMBEDDING_DIM = 4096
EMBEDDING_BYTES = EMBEDDING_DIM * 4
CHILD_EXIT_GPU_BUSY = 3
CHILD_PATH = Path(__file__).with_name("kimodo-text-encode.py")
LLAMA_BASE = "meta-llama/Meta-Llama-3-8B-Instruct"  # the base model the mntp adapter repo points at


class GpuBusy(RuntimeError):
    """The card has too little free VRAM to host the encoder; there is no CPU fallback."""

    code = "gpu-busy"

    def __init__(self, free_vram: int) -> None:
        self.free_vram = free_vram
        super().__init__(f"gpu-busy: {free_vram / GIB:.2f} GiB of VRAM free, {MIN_FREE_VRAM / GIB:.0f} GiB needed")


def plan_placement(free_vram: int, mem_available: int) -> dict:
    """The accelerate max_memory for one child call: free VRAM and available RAM, each less its reserve."""
    if free_vram < MIN_FREE_VRAM:
        raise GpuBusy(free_vram)
    return {0: free_vram - GPU_RESERVE, "cpu": max(mem_available - CPU_RESERVE, 0)}


def read_snapshot_revision(hf_home: Path, repo_id: str) -> str:
    """The commit the mounted Hugging Face cache resolves a repo's main ref to."""
    ref = Path(hf_home) / "hub" / ("models--" + repo_id.replace("/", "--")) / "refs" / "main"
    return ref.read_text().strip()


def encoder_identity(*, revisions: dict, dtype: str, transformers_version: str, peft_version: str, kimodo_commit: str) -> str:
    """The canonical string a vector is keyed under: every input that can change it."""
    parts = [f"{repo}@{revision}" for repo, revision in sorted(revisions.items())]
    parts += [f"dtype={dtype}", f"transformers={transformers_version}", f"peft={peft_version}", f"kimodo={kimodo_commit}"]
    return ";".join(parts)


def embedding_key(identity: str, text: str) -> str:
    return hashlib.sha256((identity + "\n" + text).encode("utf-8")).hexdigest()


@dataclass
class TextEmbedding:
    encoderIdentity: str
    text: str
    dtype: str
    dim: int
    vector: bytes
    vectorSha256: str
    gpuBytes: int
    cpuBytes: int
    encodeSeconds: float
    createdAt: str


TEXT_EMBEDDING = define_database_entry_type(
    "gamecult.vili.text_embedding.v0",
    [
        database_entry_field("encoderIdentity", 0, codec=t.string),
        database_entry_field("text", 1, codec=t.string),
        database_entry_field("dtype", 2, codec=t.string),
        database_entry_field("dim", 3, codec=t.int32),
        database_entry_field("vector", 4, codec=t.bytes),
        database_entry_field("vectorSha256", 5, codec=t.string),
        database_entry_field("gpuBytes", 6, codec=t.int64),
        database_entry_field("cpuBytes", 7, codec=t.int64),
        database_entry_field("encodeSeconds", 8, codec=t.float64),
        database_entry_field("createdAt", 9, codec=t.string),
    ],
    cls=TextEmbedding,
)


def open_store(path) -> CultCache:
    cache = (
        CultCache.builder()
        .register_document_type(TEXT_EMBEDDING)
        .add_generic_store(SingleFileMessagePackBackingStore(path))
        .build()
    )
    cache.pull_all_backing_stores()
    return cache


def run_child(texts: list, out_path, child_path=CHILD_PATH, timeout: float = 1800.0) -> dict:
    """Run the one-shot encoder child for `texts` and return its answer file. Raises GpuBusy or RuntimeError."""
    process = subprocess.run(
        [sys.executable, str(child_path), "--out", str(out_path)],
        input=json.dumps({"texts": texts}).encode("utf-8"),
        stdout=subprocess.DEVNULL,
        timeout=timeout,
    )
    answer = msgpack.unpackb(Path(out_path).read_bytes(), raw=False) if Path(out_path).exists() else {}
    if process.returncode == CHILD_EXIT_GPU_BUSY:
        raise GpuBusy(int(answer.get("freeVramBytes", 0)))
    if process.returncode != 0:
        raise RuntimeError(f"text encoder child failed with exit code {process.returncode}")
    return answer


def encode_misses_in_child(texts: list) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        return run_child(texts, Path(directory) / "answer.mp")


class CachedTextEncoder:
    """Kimodo's encoder contract, answered from the store; misses go to one child call per request."""

    def __init__(self, store: CultCache, identity: str, encode_misses, device="cpu", dtype_name="float32") -> None:
        self.store = store
        self.identity = identity
        self._encode_misses = encode_misses
        self._device = device
        self._dtype_name = dtype_name
        self.reset()

    def reset(self) -> None:
        self.hits = 0
        self.misses = 0
        self.encode_seconds = 0.0
        self.embeddings = []

    def to(self, device):
        self._device = device
        return self

    def eval(self):
        return self

    def get_device(self):
        return self._device

    def count(self) -> int:
        return len(self.store.get_all(TEXT_EMBEDDING))

    def __call__(self, texts):
        single = isinstance(texts, str)
        texts = [texts] if single else list(texts)
        keys = [embedding_key(self.identity, text) for text in texts]
        present = [self.store.get(TEXT_EMBEDDING, key) is not None for key in keys]
        missing = list(dict.fromkeys(text for text, found in zip(texts, present) if not found))
        self.hits += sum(present)
        self.misses += len(missing)
        if missing:
            started = time.perf_counter()
            answer = self._encode_misses(missing)
            self.encode_seconds += time.perf_counter() - started
            self._admit(missing, answer)
        rows = []
        for text, key in zip(texts, keys):
            record = self.store.get_required(TEXT_EMBEDDING, key)
            self.embeddings.append({"text": text, "vectorSha256": record.vectorSha256})
            rows.append(torch.frombuffer(bytearray(record.vector), dtype=torch.float32))
        features = torch.stack(rows)[:, None].to(self._device)
        return features, [1] * len(texts)

    def _admit(self, missing, answer) -> None:
        vectors = answer.get("vectors", [])
        if len(vectors) != len(missing) or any(len(v) != EMBEDDING_BYTES for v in vectors):
            raise RuntimeError(f"text encoder child returned {len(vectors)} vectors for {len(missing)} texts, each {EMBEDDING_BYTES} bytes expected")
        placement = answer.get("placement", {})
        seconds = answer.get("encodeSeconds", [0.0] * len(missing))
        for text, vector, took in zip(missing, vectors, seconds):
            vector = bytes(vector)
            self.store.put(TEXT_EMBEDDING, embedding_key(self.identity, text), TextEmbedding(
                encoderIdentity=self.identity,
                text=text,
                dtype="float32",
                dim=EMBEDDING_DIM,
                vector=vector,
                vectorSha256=hashlib.sha256(vector).hexdigest(),
                gpuBytes=int(placement.get("gpuBytes", 0)),
                cpuBytes=int(placement.get("cpuBytes", 0)),
                encodeSeconds=float(took),
                createdAt=datetime.now(timezone.utc).isoformat(),
            ))
