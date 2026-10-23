# kimodo.cpp probe, 2026-10-23

Directed by `motion-pipeline:ruling:remap-against-community-tooling`. Shaped by
`motion-pipeline:ruling:own-implementation-borrow-best`: kimodo.cpp is weighed as a
source of parts for Vili, not as a replacement worker. Measured by
imagination-kimodo-cpp, session sp-reentry-2026-10-21.

## Headline

1. **Vili's text vectors lack the LLM2Vec MNTP adapter.** This also holds for
   upstream Kimodo at 6bb5848 and at origin/main e1c219c. Under transformers 5.1.0,
   Kimodo's `LLM2Vec.from_pretrained("McGill-NLP/...-mntp")` reports the MNTP LoRA
   keys as UNEXPECTED (`base_model.model.layers.*`) and MISSING (`layers.*`, newly
   initialized). The merge that follows therefore merges a freshly initialized
   adapter. Two torch assemblies were run on the same machine with the same
   versions (torch 2.5.1 CPU, transformers 5.1.0, peft 0.18.1, bf16):
   - **A**, Kimodo's own `LLM2VecEncoder` (the path Vili's own loader mirrors),
     reproduces Vili's stored vectors at cosine **0.999972** (fist) and **0.999968**
     (wave).
   - **B** loads the Llama base, merges the MNTP adapter explicitly with
     `PeftModel` and then adds the supervised adapter. This is LLM2Vec's design and
     kimodo.cpp's reference assembly. It reproduces kimodo.cpp BF16 at **0.999946**
     and **0.999960**.
   - A and B agree only at cosine **0.906 to 0.936**.

   This answers the probe asked for by `motion-pipeline:follow_up:encoder-adapter-load-report`.
   Upstream has not changed `kimodo/model/llm2vec`, `load_model.py` or the
   transformers pin since 6bb5848. The probe cannot tell which encoder NVIDIA's
   denoiser was trained on: A, or a correctly loaded B from an older transformers
   version.
2. **kimodo.cpp's encoder is numerically B.** Over Vili's 8 cached prompts, its Q8_0
   output has cosine **0.9075 to 0.9354** with Vili's bf16 GPU vectors, while its BF16
   output has **0.9059 to 0.9361**. The whole gap is the
   MNTP difference above, not quantization: Q8_0 against kimodo.cpp BF16 is
   **0.99967 minimum, 0.99978 mean**, and Q8_0 against torch assembly B is **0.99972**
   (fist) and **0.99984** (wave). Upstream's own sweep reports 0.999824.
3. **Clips cannot be compared against Vili's reference clips for the same seed.** This is a
   finding, not a gap in the run. kimodo.cpp draws its initial noise with
   `std::mt19937_64` and `std::normal_distribution`. Kimodo uses torch's generator
   after `torch.manual_seed` and `torch.cuda.manual_seed_all`, on CUDA. Beyond that,
   kimodo.cpp does not run Kimodo's post-processing (Vili runs it by default), it
   returns 30 SOMA joints rather than the 77-joint posed skeleton Vili stores, and
   its CLI fixes both CFG weights at 2.0. Its fixture tools
   (`kmd-sample-embedding`, `kmd-sample-fixture`) accept injected embedding and
   noise. A like-for-like clip comparison would need Kimodo's CUDA noise captured
   on Raven's GPU and post-processing disabled on both sides. That was not done,
   because Raven's GPU was in use (below).

## Clip deltas inside kimodo.cpp (same noise bytes, embedding swapped)

Setup: SOMA-RP v1.1 F32 denoiser, 60 frames (2 s at 30 fps), 20 DDIM steps, CFG
2/2. The noise came from numpy `default_rng(seed)`. Positions come from forward
kinematics over kimodo.cpp's `soma30` offsets. Bone-length spread was at most
3e-8 m, and a rerun with the same embedding was 0.0000 mm from the first run,
so the sampler is deterministic.

| prompt | seed | Q8_0 vs kimodo.cpp BF16, mean / max mm | Vili bf16 vector vs kimodo.cpp Q8_0, mean / max mm |
|---|---|---|---|
| fist | 7 | 2.87 / 62.30 | 84.72 / 927.40 |
| fist | 42 | 2.45 / 16.46 | 43.94 / 986.76 |
| shrug | 7 | 2.06 / 17.39 | 28.42 / 145.01 |
| shrug | 42 | 3.00 / 17.83 | 16.46 / 157.28 |
| wave | 7 | 0.54 / 10.87 | 14.06 / 391.16 |
| wave | 42 | 0.94 / 20.84 | 27.70 / 553.69 |

How to read the columns:

- **Q8 against BF16** is about the size of Vili's own GPU-bf16 against CPU drift
  (fist: mean 4.63, max 54.28 mm, `motion-pipeline:verdict:cut-vili-encoder-placement.s1`).
- **MNTP against no MNTP** produces a different motion. The fist clip's root ends up
  close to a metre away.

## Resources

None of these runs touched Raven's GPU. At the time of the probe Raven's GPU showed
35 % utilization and 11.6 GiB in use, so **GPU (Vulkan) timing is undone**. It is
deferred to a run when the household tray toggle allows GPU use.

All runs were on Yggdrasil (AMD EPYC-Genoa VM, 16 vCPU, 62 GiB) in Docker
containers capped at 8 CPUs and 24 GiB (torch: 40 GiB), with `KIMODO_THREADS=8`.
The host was shared with other agents' verification containers, so the timings are
noisy.

| what | wall | peak RSS |
|---|---|---|
| kimodo.cpp Q8_0 encode, cold process (load and 1st encode) | 6.8 to 14 s (27 s on the very first, cold page cache) | 1.97 to 2.12 GiB |
| kimodo.cpp Q8_0 encode, warm 2nd encode in-process | 3.2 to 7.8 s | the same |
| kimodo.cpp BF16 encode, cold process (warm in-process encode 8.2 to 12.5 s) | 16.6 to 38 s | 3.45 to 3.60 GiB |
| kimodo.cpp 2 s clip from embedding (`kmd-sample-embedding`, 20 steps, includes the 1.1 GB denoiser load) | 26 to 75 s, typically about 30 s | 1.13 GiB |
| kimodo.cpp text to 2 s clip end to end (`kmd-generate`, Q8_0) | 42.9 s | 2.05 GiB |
| torch assembly A or B, bf16 CPU, model load / encode | 41 s or 38 s / 0.9 to 2.1 s | about 16 GiB of weights (peak not sampled) |

For comparison, today on Raven: a cache hit costs about 2 s for a 2 s clip, and a
miss costs a 61 s encode (`cut-vili-encoder-placement.s1`). Raven has 16 GiB of host
RAM, which is why its CPU bf16 encode took 428 s; Yggdrasil's 1 to 2 s CPU bf16
encode is a RAM fact, not a CPU fact. kimodo.cpp's Q8 encoder reads its weights
layer by layer and needs about 2 GiB resident, so it would fit Raven on CPU.

## Feature coverage (kimodo.cpp ed8a931, 2026-10-19)

- Checkpoints: SOMA-RP and SOMA-SEED **v1.1** only, plus G1 and a locally converted
  SMPL-X. There is **no v1.2** (`motion-pipeline:follow_up:kimodo-v1-2`).
- Skeleton: the 30 joints SOMA predicts. 77-joint expansion is "not implemented yet".
- Output: raw local rotations and root positions as f32, and skeleton-only
  `animation.glb` from the Go demo. There is **no BVH or FBX from the binaries**
  (`scripts/export_bvh.py` is a Python helper), and no skinned GLB.
- Constraints: "General constraint input ... not implemented". The C API
  carries a `constraint_cfg_weight` but no constraint data. Vili's
  `load_constraints_lst` path has no equivalent. Multi-prompt sequences with
  transitions are supported.
- Post-processing: Kimodo's motion correction and foot handling do not run in the
  inference path.
- Backends: CPU and Vulkan. Windows MSVC builds via the fork TheLocalLab/kimodo.cpp-windows,
  merged upstream 2026-08-31.

## Maintenance signal and licence

- **Port.** github.com/localai-org/kimodo.cpp, Apache-2.0, 34 commits from
  2026-08-22 to 2026-10-19. Richard Palethorpe wrote 30 of them, with 3 from
  Deepesh70 and 1 from mudler-agent. It is published by the LocalAI team, and the
  README carries their attribution. It has 929 stars. The last functional commits
  were 2026-09-17 (performance work and the monolithic quantizations); since then
  there has been one README commit. GGML is a pinned submodule. The code is built
  for parity work: reference capture harness, layer, stage and fixture parity
  tests, fuzzers and sanitizer presets.
- **Installer defect seen.** `scripts/download_gguf_weights.sh` exits with
  "missing or wrong-sized file: generated/llm2vec-text-bundle/tokenizer.gguf",
  because MANIFEST.json still lists the legacy split bundle. The monolith files
  were verified by hand against the manifest's sha256 values:
  - Q8_0 `b26d0e74...4c5c` (8,142,058,752 bytes)
  - BF16 `d9a60017...b20f` (15,177,675,936 bytes)
  - tokenizer `81614aca...607e`
- **Quantized weights.**
  - HF `LocalAI-io/Llama-3-Kimodo-GGML` was created 2026-08-23, last modified
    2026-09-17, has 161,096 downloads, and is licensed "other". It was quantized by
    LocalAI-io with their own `kmd-quantize-text` (Q8_0 for the large matrices;
    RMSNorm in BF16 and the supervised LoRA in F32, unquantized).
  - It was converted from exactly the revisions in Vili's encoder identity:
    `meta-llama/Meta-Llama-3-8B-Instruct@8afb486c`, `McGill-NLP/...-mntp@31474e39`
    and `...-mntp-supervised@baa8ebf0`. Its manifest records them.
  - It carries the Meta Llama 3 Community License, and the LLM2Vec adapters are MIT.
  - The SOMA-RP v1.1 GGUF (`kimodo-soma-rp-v1.1-f32.gguf`, sha256 `3bf1229f...8ee4`)
    is a one-to-one conversion under the NVIDIA Open Model License.

## Method and custody

- **Reference vectors.** The 8 reference vectors came from a read-only copy of
  Raven's `E:\Projects\Vili\.vili\embeddings\text-embeddings.cc`, decoded with
  cultcache-py and Vili's `gamecult.vili.text_embedding.v0` definition. Every
  vectorSha256 checked. kimodo.cpp was fed each record's stored, already
  normalized text.
- **Torch assemblies.** These used the McGill adapters and the Llama config,
  copied from Raven's WSL Hugging Face cache, and the four Llama safetensors
  shards from the ungated mirror `NousResearch/Meta-Llama-3-8B-Instruct`. Those
  shards are byte-identical to Raven's blobs: the sha256 values `d8cf9c4d`,
  `8d4782b4`, `3acdd690` and `67e9ad31` match. No Hugging Face token left Raven.
- **Nothing on Raven was touched** beyond those reads: not Vili's daemon, its
  worker container, or the GPU.
- **Yggdrasil scratch** is `~/scratch/kimodo-cpp-probe` (39 GiB: weights,
  checkouts, outputs). The probe's containers are all removed. Delete the scratch
  directory once nobody needs to rerun the probe.

**Correction, 2026-10-23.** The "MNTP missing" diagnosis in this document is wrong. The MNTP adapter is applied in both loads (the cut measured a q_proj difference of 0.0117 for repo ids and snapshot paths alike). What separates A from B is the Llama-3 chat header: Kimodo's `LLM2Vec.prepare_for_tokenization` wraps the text in it only when the model's `_name_or_path` is the repo id `meta-llama/Meta-Llama-3-8B-Instruct`, which a load from a snapshot path silently drops (`motion-pipeline:finding:cut-vili-cpu-body.s1.ab-premise-inverted`). B's weights with the bare header give cosine 0.9977 to A, and without it 1.0 to B; the header plus LLM2Vec's instruction marker, which keeps the header out of the pooling as Kimodo's encode path does, gives 1.0 to A (checked 2026-10-23). Vili now applies the header explicitly (`motion-pipeline:ruling:encoder-chat-header-on`). The measurements above stand as measured; read "MNTP" in the A/B account as "the chat header".
