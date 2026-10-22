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
            "placement": {"gpuBytes": 11 * GIB, "cpuBytes": 5 * GIB},
        }


def open_encoder(directory, child, identity="id-a"):
    store = te.open_store(Path(directory) / "embeddings.cc")
    return te.CachedTextEncoder(store, identity, child)


class PlanPlacement(unittest.TestCase):
    def test_refuses_below_two_gib_with_a_typed_error_and_no_cpu_placement(self):
        for free in (0, 1 * GIB, int(1.5 * GIB), 2 * GIB - 1):
            with self.assertRaises(te.GpuBusy) as raised:
                te.plan_placement(free, 64 * GIB)
            self.assertEqual(raised.exception.code, "gpu-busy")
            self.assertEqual(raised.exception.free_vram, free)

    def test_splits_free_vram_and_ram_each_less_the_reserve(self):
        self.assertEqual(te.plan_placement(12 * GIB, 7 * GIB), {0: 12 * GIB - te.GPU_RESERVE, "cpu": 7 * GIB - te.CPU_RESERVE})
        self.assertEqual(te.plan_placement(14 * GIB, 10 * GIB), {0: 14 * GIB - te.GPU_RESERVE, "cpu": 10 * GIB - te.CPU_RESERVE})

    def test_the_gpu_reserve_exceeds_the_old_one_that_crashed_at_the_card_ceiling(self):
        self.assertGreater(te.GPU_RESERVE, int(1.5 * GIB))

    def test_ram_below_the_reserve_never_goes_negative(self):
        self.assertEqual(te.plan_placement(12 * GIB, GIB)["cpu"], 0)


class Identity(unittest.TestCase):
    def test_key_changes_with_identity_and_text_and_is_stable(self):
        self.assertEqual(te.embedding_key("a", "x"), te.embedding_key("a", "x"))
        self.assertNotEqual(te.embedding_key("a", "x"), te.embedding_key("b", "x"))
        self.assertNotEqual(te.embedding_key("a", "x"), te.embedding_key("a", "y"))
        self.assertNotEqual(te.embedding_key("ab", "x"), te.embedding_key("a", "bx"))

    def test_identity_names_every_input(self):
        base = dict(revisions={"r/one": "111", "r/two": "222"}, dtype="bfloat16", transformers_version="5.1.0", peft_version="0.18.1", kimodo_commit="6bb5848")
        identity = te.encoder_identity(**base)
        for field, other in (("dtype", "float32"), ("transformers_version", "5.2.0"), ("peft_version", "0.19.0"), ("kimodo_commit", "abcdef0"),
                             ("revisions", {"r/one": "111", "r/two": "333"})):
            self.assertNotEqual(identity, te.encoder_identity(**{**base, field: other}), field)

    def test_snapshot_revision_is_read_from_the_mounted_cache(self):
        with tempfile.TemporaryDirectory() as home:
            refs = Path(home) / "hub" / "models--org--name" / "refs"
            refs.mkdir(parents=True)
            (refs / "main").write_text("deadbeef\n")
            self.assertEqual(te.read_snapshot_revision(Path(home), "org/name"), "deadbeef")


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

    def test_gpu_busy_propagates_without_a_cpu_path_and_stores_nothing(self):
        def busy(texts):
            raise te.GpuBusy(GIB)

        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, busy)
            with self.assertRaises(te.GpuBusy) as raised:
                encoder([SECRET])
            self.assertNotIn(SECRET, str(raised.exception))
            self.assertEqual(encoder.count(), 0)

    def test_the_contract_methods_return_self_or_the_device(self):
        with tempfile.TemporaryDirectory() as directory:
            encoder = open_encoder(directory, FakeChild())
            self.assertIs(encoder.to("cpu"), encoder)
            self.assertIs(encoder.eval(), encoder)
            self.assertEqual(encoder.get_device(), "cpu")


class ChildBoundary(unittest.TestCase):
    def run_stub(self, body, texts=("aa",)):
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / "child.py"
            stub.write_text(textwrap.dedent(body))
            return te.run_child(list(texts), Path(directory) / "out.mc", child_path=stub, timeout=60)

    def test_exit_three_is_gpu_busy_with_the_measured_free_vram(self):
        with self.assertRaises(te.GpuBusy) as raised:
            self.run_stub("""
                import sys, msgpack
                out = sys.argv[sys.argv.index("--out") + 1]
                open(out, "wb").write(msgpack.packb({"error": "gpu-busy", "freeVramBytes": 1234}, use_bin_type=True))
                sys.exit(3)
            """)
        self.assertEqual(raised.exception.free_vram, 1234)

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
