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
EMBEDDING_DIM = 4096
EMBEDDING_BYTES = EMBEDDING_DIM * 4
CHILD_PATH = Path(__file__).with_name("kimodo-text-encode.py")
LLAMA_BASE = "meta-llama/Meta-Llama-3-8B-Instruct"  # the base model both LLM2Vec adapters are applied to
ASSEMBLY = "llm2vec-mntp-merged-then-supervised"
# Llama-3 Instruct's chat header, applied by Vili's own code (motion-pipeline:ruling:encoder-chat-header-on): the
# text goes in as a user turn, as LLM2Vec does for this model when it is loaded from the repo id. The separator is
# LLM2Vec's instruction/query marker: the model attends over the whole turn, and pooling covers what follows the
# marker (the text and the end-of-turn token), not the header, exactly as Kimodo's encoder pools.
CHAT_HEADER_PREFIX = "<|start_header_id|>user<|end_header_id|>\n\n"
CHAT_HEADER_SUFFIX = "<|eot_id|>"
QUERY_SEPARATOR = "!@#$%^&*()"
PROMPT_FORM = "llama3-chat-header:" + hashlib.sha256("|".join((CHAT_HEADER_PREFIX, QUERY_SEPARATOR, CHAT_HEADER_SUFFIX)).encode("utf-8")).hexdigest()
MAX_THREADS = 16


def thread_cap(environ) -> int:
    """VILI_THREADS, the one torch thread budget of the worker and its encoder child: an integer from 1 to MAX_THREADS."""
    raw = environ.get("VILI_THREADS", "")
    if not raw.isascii() or not raw.isdigit() or not 1 <= int(raw) <= MAX_THREADS:
        raise ValueError(f"VILI_THREADS must be an integer from 1 to {MAX_THREADS}")
    return int(raw)


def apply_thread_cap(environ) -> int:
    threads = thread_cap(environ)
    torch.set_num_threads(threads)
    return threads


def read_snapshot_revision(hf_home: Path, repo_id: str) -> str:
    """The commit the mounted Hugging Face cache resolves a repo's main ref to."""
    ref = Path(hf_home) / "hub" / ("models--" + repo_id.replace("/", "--")) / "refs" / "main"
    return ref.read_text().strip()


def snapshot_path(hf_home: Path, repo_id: str) -> Path:
    """The directory of the snapshot read_snapshot_revision names: assembly B loads from these, never from repo ids."""
    return Path(hf_home) / "hub" / ("models--" + repo_id.replace("/", "--")) / "snapshots" / read_snapshot_revision(hf_home, repo_id)


def chat_header(text: str) -> str:
    """The text as the encoder reads it: a user turn in Llama-3 Instruct's chat format, pooled after the separator."""
    return CHAT_HEADER_PREFIX + (QUERY_SEPARATOR + text).strip() + CHAT_HEADER_SUFFIX


def encoder_identity(*, assembly: str, prompt_form: str, device: str, revisions: dict, dtype: str, torch_version: str,
                     transformers_version: str, peft_version: str, accelerate_version: str, kimodo_commit: str,
                     loader_sha256: str) -> str:
    """The canonical string a vector is keyed under: every input that can change it, in a fixed field order.

    Thread count is provenance, not identity; the encoder child's own bytes are, through loader_sha256."""
    parts = [f"{repo}@{revision}" for repo, revision in sorted(revisions.items())]
    parts += [
        f"assembly={assembly}", f"prompt={prompt_form}", f"device={device}", f"dtype={dtype}", f"torch={torch_version}", f"transformers={transformers_version}",
        f"peft={peft_version}", f"accelerate={accelerate_version}", f"kimodo={kimodo_commit}", f"loader={loader_sha256}",
    ]
    return ";".join(parts)


def installed_versions() -> dict:
    """The versions of the libraries that load and run the encoder, read from the installed packages."""
    import accelerate
    import peft
    import transformers
    return {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__, "accelerate": accelerate.__version__}


def live_identity(hf_home, preset: dict, kimodo_commit: str) -> str:
    """The identity the worker keys vectors under: the three snapshot revisions the mounted cache names, the preset's
    dtype, the library versions, the Kimodo commit and the sha256 of the encoder child's own bytes."""
    versions = installed_versions()
    repos = (preset["base_model_name_or_path"], preset["peft_model_name_or_path"], LLAMA_BASE)
    return encoder_identity(
        assembly=ASSEMBLY, prompt_form=PROMPT_FORM, device="cpu",
        revisions={repo: read_snapshot_revision(hf_home, repo) for repo in repos},
        dtype=preset["dtype"], torch_version=versions["torch"], transformers_version=versions["transformers"],
        peft_version=versions["peft"], accelerate_version=versions["accelerate"], kimodo_commit=kimodo_commit,
        loader_sha256=hashlib.sha256(CHILD_PATH.read_bytes()).hexdigest(),
    )


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
    """Run the one-shot encoder child for `texts` and return its answer file. Raises RuntimeError on any non-zero exit."""
    process = subprocess.run(
        [sys.executable, str(child_path), "--out", str(out_path)],
        input=json.dumps({"texts": texts}).encode("utf-8"),
        stdout=subprocess.DEVNULL,
        timeout=timeout,
    )
    answer = msgpack.unpackb(Path(out_path).read_bytes(), raw=False) if Path(out_path).exists() else {}
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
                gpuBytes=0,
                cpuBytes=int(placement.get("cpuBytes", 0)),
                encodeSeconds=float(took),
                createdAt=datetime.now(timezone.utc).isoformat(),
            ))
