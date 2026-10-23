"""Run inside the Kimodo image: python -m unittest discover -s /opt/vili -p test_text_encoding.py"""
import hashlib
import os
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import text_encoding as te  # noqa: E402

GIB = te.GIB
SECRET = "a person whispers the launch code"


def vector(seed: int) -> bytes:
    return bytes([seed % 251]) * te.EMBEDDING_BYTES


class FakeChild:
    """Stands in for the encoder child: one call per request, vectors derived from the text."""

    def __init__(self):
        self.calls = []

    def __call__(self, texts):
        self.calls.append(list(texts))
        return {
            "vectors": [vector(len(text)) for text in texts],
            "encodeSeconds": [0.5] * len(texts),
            "placement": {"cpuBytes": 5 * GIB},
        }


def open_encoder(directory, child, identity="id-a"):
    store = te.open_store(Path(directory) / "embeddings.cc")
    return te.CachedTextEncoder(store, identity, child)


class Identity(unittest.TestCase):
    def test_key_changes_with_identity_and_text_and_is_stable(self):
        self.assertEqual(te.embedding_key("a", "x"), te.embedding_key("a", "x"))
        self.assertNotEqual(te.embedding_key("a", "x"), te.embedding_key("b", "x"))
        self.assertNotEqual(te.embedding_key("a", "x"), te.embedding_key("a", "y"))
        self.assertNotEqual(te.embedding_key("ab", "x"), te.embedding_key("a", "bx"))

    def test_key_is_a_full_sha256_over_the_whole_text(self):
        key = te.embedding_key("id", "text a")
        self.assertEqual(len(key), 64)
        int(key, 16)
        self.assertNotEqual(key, te.embedding_key("id", "text b"))
        self.assertNotEqual(te.embedding_key("id", "a" * 300 + "x"), te.embedding_key("id", "a" * 300 + "y"))

    def test_key_is_case_sensitive(self):
        self.assertNotEqual(te.embedding_key("id", "A person waves."), te.embedding_key("id", "a person waves."))

    def test_chat_header_is_the_llama3_user_turn_pooled_after_the_separator(self):
        header = "<|start_header_id|>user<|end_header_id|>" + chr(10) * 2
        self.assertEqual(te.chat_header("hello  "), header + "!@#$%^&*()hello<|eot_id|>")
        self.assertEqual(te.chat_header("  hello"), header + "!@#$%^&*()  hello<|eot_id|>")
        form = hashlib.sha256(("|".join((header, "!@#$%^&*()", "<|eot_id|>"))).encode("utf-8")).hexdigest()
        self.assertEqual(te.PROMPT_FORM, "llama3-chat-header:" + form)

    def test_every_identity_field_changes_the_key(self):
        # Built the way the worker builds it, from a mounted cache with 40-hex revisions, so the first 268 characters
        # are the revisions and every other field sits past any prefix a truncated identity could keep.
        preset = {"base_model_name_or_path": "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp", "peft_model_name_or_path":
                  "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised", "dtype": "bfloat16"}
        versions = {"torch": "2.5.1+cpu", "transformers": "5.1.0", "peft": "0.18.1", "accelerate": "1.13.0"}
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as bytes_dir:
            loader = Path(bytes_dir) / "child.py"
            loader.write_bytes(b"one")
            repos = [preset["base_model_name_or_path"], preset["peft_model_name_or_path"], te.LLAMA_BASE]
            revision = {repo: f"{index}" * 40 for index, repo in enumerate(repos, start=1)}

            def write_revision(repo, value):
                refs = Path(home) / "hub" / ("models--" + repo.replace("/", "--")) / "refs"
                refs.mkdir(parents=True, exist_ok=True)
                (refs / "main").write_text(value + chr(10))

            for repo in repos:
                write_revision(repo, revision[repo])
            real_child, real_versions = te.CHILD_PATH, te.installed_versions
            te.CHILD_PATH = loader
            try:
                def identity(preset=preset, commit="6bb5848", versions=versions):
                    te.installed_versions = lambda: versions
                    return te.live_identity(home, preset, commit)

                base = identity()
                self.assertGreater(base.index("assembly="), 200)
                changed = {
                    "dtype": identity(preset={**preset, "dtype": "float32"}),
                    "kimodo": identity(commit="abcdef0"),
                    **{f"version:{name}": identity(versions={**versions, name: "9.9.9"}) for name in versions},
                }
                for repo in repos:
                    write_revision(repo, "f" * 40)
                    changed[f"revision:{repo}"] = identity()
                    write_revision(repo, revision[repo])
                loader.write_bytes(b"two")
                changed["loader"] = identity()
                loader.write_bytes(b"one")
                self.assertEqual(identity(), base)
            finally:
                te.CHILD_PATH, te.installed_versions = real_child, real_versions
            self.assertEqual(len(changed), 10)
            for field, other in changed.items():
                self.assertNotEqual(te.embedding_key(base, "x"), te.embedding_key(other, "x"), field)
            for part in (f"assembly={te.ASSEMBLY}", f"prompt={te.PROMPT_FORM}", "device=cpu", "dtype=bfloat16", "torch=2.5.1+cpu"):
                self.assertIn(part, base)

    def test_assembly_prompt_and_device_change_the_key(self):
        fields = dict(
            assembly=te.ASSEMBLY, prompt_form=te.PROMPT_FORM, device="cpu", revisions={"r/one": "1" * 40}, dtype="bfloat16",
            torch_version="2.5.1+cpu", transformers_version="5.1.0", peft_version="0.18.1", accelerate_version="1.13.0",
            kimodo_commit="6bb5848", loader_sha256="a" * 64,
        )
        key = te.embedding_key(te.encoder_identity(**fields), "x")
        for name, other in (("assembly", "llm2vec-A"), ("prompt_form", "none"), ("device", "other-device")):
            self.assertNotEqual(key, te.embedding_key(te.encoder_identity(**{**fields, name: other}), "x"), name)

    def test_installed_versions_are_read_from_the_libraries_in_use(self):
        fakes = {name: types.SimpleNamespace(__version__=f"{name}-v") for name in ("transformers", "peft", "accelerate")}
        with mock.patch.dict(sys.modules, fakes), mock.patch.object(te.torch, "__version__", "torch-v"):
            self.assertEqual(te.installed_versions(), {
                "torch": "torch-v", "transformers": "transformers-v", "peft": "peft-v", "accelerate": "accelerate-v",
            })


class SnapshotPath(unittest.TestCase):
    def test_resolves_the_revision_the_mounted_cache_names(self):
        with tempfile.TemporaryDirectory() as home:
            repo = Path(home) / "hub" / "models--org--name"
            (repo / "refs").mkdir(parents=True)
            (repo / "refs" / "main").write_text("deadbeef" + chr(10))
            (repo / "snapshots" / "deadbeef").mkdir(parents=True)
            self.assertEqual(te.snapshot_path(Path(home), "org/name"), repo / "snapshots" / "deadbeef")


class CachedEncoder(unittest.TestCase):
    def test_one_child_call_for_a_requests_misses_and_none_for_hits(self):
        with tempfile.TemporaryDirectory() as directory:
            child = FakeChild()
            encoder = open_encoder(directory, child)
            features, lengths = encoder(["aa", "bbb", "aa", ""])
            self.assertEqual(child.calls, [["aa", "bbb", ""]])
            self.assertEqual(tuple(features.shape), (4, 1, te.EMBEDDING_DIM))
            self.assertEqual(lengths, [1, 1, 1, 1])
            self.assertEqual((encoder.hits, encoder.misses), (0, 3))
            encoder.reset()
            again, _ = encoder(["bbb", "aa"])
            self.assertEqual(len(child.calls), 1)
            self.assertEqual((encoder.hits, encoder.misses, encoder.encode_seconds), (2, 0, 0.0))
            self.assertTrue((again[0] == features[1]).all() and (again[1] == features[0]).all())

    def test_a_new_encoder_on_the_same_file_hits(self):
        with tempfile.TemporaryDirectory() as directory:
            open_encoder(directory, FakeChild())(["aa"])
            second = FakeChild()
            encoder = open_encoder(directory, second)
            encoder(["aa"])
            self.assertEqual(second.calls, [])
            self.assertEqual(encoder.count(), 1)

    def test_a_different_identity_misses(self):
        with tempfile.TemporaryDirectory() as directory:
            open_encoder(directory, FakeChild(), "id-a")(["aa"])
            other = FakeChild()
            open_encoder(directory, other, "id-b")(["aa"])
            self.assertEqual(other.calls, [["aa"]])

    def test_same_text_yields_the_same_vector_hash_every_time(self):
        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, FakeChild())
            encoder(["aa"])
            encoder(["aa"])
            self.assertEqual(len(encoder.embeddings), 2)
            self.assertEqual(len({row["vectorSha256"] for row in encoder.embeddings}), 1)

    def test_a_wrong_sized_vector_is_refused_and_not_stored(self):
        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, lambda texts: {"vectors": [b"short"] * len(texts), "placement": {}})
            with self.assertRaises(RuntimeError) as raised:
                encoder([SECRET])
            self.assertNotIn(SECRET, str(raised.exception))
            self.assertEqual(encoder.count(), 0)

    def test_a_child_answer_with_too_few_vectors_is_refused_and_stores_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, lambda texts: {"vectors": [vector(1)], "placement": {}})
            with self.assertRaises(RuntimeError):
                encoder(["aa", "bb"])
            self.assertEqual(encoder.count(), 0)

    def test_kimodos_text_dimension_is_4096(self):
        self.assertEqual(te.EMBEDDING_DIM, 4096)
        self.assertEqual(te.EMBEDDING_BYTES, 4096 * 4)
        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, FakeChild())
            features, _ = encoder(["aa"])
            self.assertEqual(tuple(features.shape), (1, 1, 4096))
            self.assertEqual(encoder.store.get_all(te.TEXT_EMBEDDING)[0].dim, 4096)

    def test_the_contract_methods_return_self_or_the_device(self):
        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, FakeChild())
            self.assertIs(encoder.to("cpu"), encoder)
            self.assertIs(encoder.eval(), encoder)
            self.assertEqual(encoder.get_device(), "cpu")


class ThreadCap(unittest.TestCase):
    def test_accepts_one_to_sixteen(self):
        for raw in ("1", "8", "16"):
            self.assertEqual(te.thread_cap({"VILI_THREADS": raw}), int(raw))

    def test_refuses_the_rest_without_echoing_the_value(self):
        for raw in ("", "0", "17", "-1", "8.5", "eight", " 8", "\u0668"):
            with self.assertRaises(ValueError) as raised:
                te.thread_cap({"VILI_THREADS": raw})
            self.assertNotIn(raw or "NUL", str(raised.exception))
        with self.assertRaises(ValueError):
            te.thread_cap({})

    def test_apply_sets_torch_to_the_cap(self):
        before = te.torch.get_num_threads()
        try:
            self.assertEqual(te.apply_thread_cap({"VILI_THREADS": "3"}), 3)
            self.assertEqual(te.torch.get_num_threads(), 3)
        finally:
            te.torch.set_num_threads(before)

    def test_the_child_applies_the_cap_before_it_loads_anything(self):
        source = (Path(te.__file__).with_name("kimodo-text-encode.py")).read_text()
        self.assertLess(source.index("apply_thread_cap(os.environ)"), source.index("load_encoder(os.environ"))

    def test_the_worker_caps_interop_threads_before_it_loads_the_model(self):
        source = (Path(te.__file__).with_name("kimodo-resident-worker.py")).read_text()
        self.assertLess(source.index("torch.set_num_interop_threads(1)"), source.index("model, resolved_model = load_model("))

    def test_the_worker_applies_the_cap_before_it_loads_the_model(self):
        source = (Path(te.__file__).with_name("kimodo-resident-worker.py")).read_text()
        self.assertLess(source.index("text_encoding.apply_thread_cap(os.environ)"), source.index("model, resolved_model = load_model("))


class ChildBoundary(unittest.TestCase):
    def run_stub(self, body, texts=("aa",)):
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / "child.py"
            stub.write_text(textwrap.dedent(body))
            return te.run_child(list(texts), Path(directory) / "out.mc", child_path=stub, timeout=60)

    def test_other_failures_name_the_exit_code_and_never_the_text(self):
        with self.assertRaises(RuntimeError) as raised:
            self.run_stub("import sys; sys.exit(1)", texts=(SECRET,))
        self.assertIn("exit code 1", str(raised.exception))
        self.assertNotIn(SECRET, str(raised.exception))

    def test_success_returns_the_answer_file_and_the_child_gets_the_texts_on_stdin(self):
        answer = self.run_stub("""
            import json, sys, msgpack
            texts = json.load(sys.stdin)["texts"]
            out = sys.argv[sys.argv.index("--out") + 1]
            open(out, "wb").write(msgpack.packb({"vectors": [b"x" * 16384 for _ in texts], "texts_seen": texts}, use_bin_type=True))
        """, texts=("aa", "bb"))
        self.assertEqual(answer["texts_seen"], ["aa", "bb"])
        self.assertEqual(len(answer["vectors"]), 2)


class ChildHeader(unittest.TestCase):
    def test_every_text_is_tokenized_with_the_chat_header(self):
        import importlib.util
        import torch
        spec = importlib.util.spec_from_file_location("kimodo_text_encode", Path(te.__file__).with_name("kimodo-text-encode.py"))
        child = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(child)

        class Recorder:
            def __init__(self):
                self.seen = []

            def tokenize(self, batch):
                self.seen.extend(batch)
                return batch

            def forward(self, features):
                return torch.zeros(1, te.EMBEDDING_DIM)

        model = Recorder()
        vectors, seconds = child.encode_texts(model, ["a person waves", "  padded  "])
        self.assertEqual(model.seen, [te.chat_header("a person waves"), te.chat_header("  padded  ")])
        for header in model.seen:
            self.assertTrue(header.startswith("<|start_header_id|>user<|end_header_id|>" + chr(10) * 2))
        self.assertEqual([len(v) for v in vectors], [te.EMBEDDING_DIM * 4] * 2)
        self.assertEqual(len(seconds), 2)


# sha256 of the two Kimodo sources the encoder mirrors, at vendor/kimodo 6bb58488 (embedding-identity-complete).
# A Kimodo bump that changes either file must re-read the mirrored loader before these move.
KIMODO_LOADER_SHA256 = {
    "model/load_model.py": "008092cd0b7adef1faea9fa9075718a61bea8ca9feaf9acf1b1d6caacaa0380a",
    "model/llm2vec/llm2vec.py": "dc6e8b7d38086b4f456e013ab22cd4cc2cd72eb7fd2c13069f037f42aec80857",
}


class KimodoPin(unittest.TestCase):
    def test_the_mirrored_loader_sources_are_the_pinned_ones(self):
        import hashlib
        import kimodo
        root = Path(kimodo.__file__).resolve().parent
        for relative, expected in KIMODO_LOADER_SHA256.items():
            self.assertEqual(hashlib.sha256((root / relative).read_bytes()).hexdigest(), expected, relative)


REFERENCE_MODELS = os.environ.get("VILI_REFERENCE_MODELS")
ROCK = "A person shakes their fist up and down three times, then thrusts a closed fist forward like a rock."
REFERENCE_CODE = """
import sys, numpy as np
from kimodo.model.load_model import TEXT_ENCODER_PRESETS
from kimodo.model.llm2vec.llm2vec_wrapper import LLM2VecEncoder
kwargs = TEXT_ENCODER_PRESETS["llm2vec"]["kwargs"]
encoder = LLM2VecEncoder(**{**kwargs, "device": "cpu"})
vector, _ = encoder(sys.argv[2])
np.save(sys.argv[1], vector.float().numpy().reshape(-1))
"""


@unittest.skipUnless(REFERENCE_MODELS, "set VILI_REFERENCE_MODELS to a Hugging Face cache with the three repos (Yggdrasil)")
class ReferenceVector(unittest.TestCase):
    """The encoder child, in a fresh process, against Kimodo's own encoder loaded from the repo ids (which applies the chat header)."""

    def test_the_child_vector_matches_kimodo_with_the_chat_header(self):
        import numpy as np
        env = {**os.environ, "HF_HOME": REFERENCE_MODELS, "HF_HUB_OFFLINE": "1", "VILI_THREADS": os.environ.get("VILI_THREADS", "8")}
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.npy"
            subprocess.run([sys.executable, "-c", REFERENCE_CODE, str(reference), ROCK], env=env, check=True)
            os.environ.update(env)
            ours = np.frombuffer(te.run_child([ROCK], Path(directory) / "answer.mp")["vectors"][0], dtype=np.float32)
            expected = np.load(reference)
        cosine = float(ours @ expected / (np.linalg.norm(ours) * np.linalg.norm(expected)))
        print("cosine to Kimodo from repo ids:", cosine)
        self.assertGreaterEqual(cosine, 0.9999)


if __name__ == "__main__":
    unittest.main()
