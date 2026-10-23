"""Run inside the Kimodo image: python -m unittest discover -s /opt/vili -p test_text_encoding.py"""
import sys
import tempfile
import textwrap
import unittest
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

    def test_every_identity_field_changes_the_key(self):
        # The repos' names alone exceed 40 characters, so a key built from a truncated identity cannot tell
        # the later fields apart: each field here sits past that point.
        base = dict(
            assembly=te.ASSEMBLY, device="cpu", revisions={"r/one": "111", "r/two": "222", "r/three": "333"}, dtype="bfloat16",
            torch_version="2.5.1+cpu", transformers_version="5.1.0", peft_version="0.18.1", accelerate_version="1.13.0",
            kimodo_commit="6bb5848", loader_sha256="a" * 64,
        )
        key = te.embedding_key(te.encoder_identity(**base), "x")
        changes = dict(
            assembly="llm2vec-A", device="other-device", dtype="float32", torch_version="2.6.0+cpu", transformers_version="5.2.0",
            peft_version="0.19.0", accelerate_version="1.14.0", kimodo_commit="abcdef0", loader_sha256="b" * 64,
        )
        for repo in base["revisions"]:
            changes[f"revision:{repo}"] = {**base["revisions"], repo: "999"}
        self.assertEqual(len(changes), 12)
        for field, other in changes.items():
            name = "revisions" if field.startswith("revision:") else field
            changed = te.embedding_key(te.encoder_identity(**{**base, name: other}), "x")
            self.assertNotEqual(key, changed, field)

    def test_snapshot_revision_is_read_from_the_mounted_cache(self):
        with tempfile.TemporaryDirectory() as home:
            refs = Path(home) / "hub" / "models--org--name" / "refs"
            refs.mkdir(parents=True)
            (refs / "main").write_text("deadbeef\n")
            self.assertEqual(te.read_snapshot_revision(Path(home), "org/name"), "deadbeef")


class SnapshotPath(unittest.TestCase):
    def test_resolves_the_revision_the_mounted_cache_names(self):
        with tempfile.TemporaryDirectory() as home:
            repo = Path(home) / "hub" / "models--org--name"
            (repo / "refs").mkdir(parents=True)
            (repo / "refs" / "main").write_text("deadbeef
")
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


if __name__ == "__main__":
    unittest.main()
