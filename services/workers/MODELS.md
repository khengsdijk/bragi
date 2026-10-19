# Model registry

The **mandatory** registry of every model the workers use ([04 §9](../../specs/04-analysis-pipeline.md),
[13 §4](../../specs/13-agent-guide.md)). Weights are never committed, are pinned here by SHA-256, are
fetched at image build time, and workers never download them at runtime. A model with a
non-commercial weights licence is flagged and needs replacing before any commercial launch (Q6 in
[15](../../specs/15-open-questions.md)).

## In use

| Name | Task | Version / checkpoint | SHA-256 | Code licence | Weights licence | Commercial use | Source | Verified |
|---|---|---|---|---|---|---|---|---|
| Beat This! `final0` | beats + downbeats (`analysis.rhythm`) | `beat-this` 1.1.0, checkpoint `final0.ckpt` (77.3 MB; trained on all data except GTZAN, seed 0) | `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331` | MIT | MIT | **yes**, with one caveat: the project's README notes that some training files are fully copyrighted or under limited Creative Commons licences, so a commercial launch should confirm it is comfortable with the training-data provenance (Q34) | code: <https://github.com/CPJKU/beat_this>; weights: <https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt> | 2026-10-19 |

The Beat This! loader (`bragi_analysis.trackers.beat_this`) refuses any checkpoint whose SHA-256
differs from the pin and reads it with `torch.load(weights_only=True)`. Set
`BRAGI_BEAT_THIS_CHECKPOINT` to the file; the worker `Dockerfile` does so for the `WITH_ML=1` build.

## Hosted model (no weights in the repo) — WP-1.7

| Name | Task | Version | SHA-256 | Code licence | Weights / service licence | Commercial use | Source | Verified |
|---|---|---|---|---|---|---|---|---|
| Anthropic Claude | `analysis.describe` text generation | configured in `bragi_analysis/config/describe.toml` (default `claude-sonnet-5-5`; `BRAGI_DESCRIBE_MODEL` or the job param `model` override it) | n/a (hosted API, no weights) | `anthropic` SDK: MIT | Anthropic commercial API terms; the ID and the key are an owner decision (Q71) | per the Anthropic API terms (owner confirms, Q71) | <https://api.anthropic.com>; SDK <https://github.com/anthropics/anthropic-sdk-python> | 2026-10-19 (SDK installed; no API key or call in this environment) |

The `describe` stage sends **derived features and controlled labels only** — no audio, lyrics, file
names, artist or title metadata ([10 §7](../../specs/10-fusion.md)) — over outbound HTTPS from the
worker. [ADR-0012](../../specs/decisions/ADR-0012-describe-llm-client.md) records the SDK choice and
its transitive licences.

## Not models, but licensed components the stages depend on

| Component | Used by | Licence | Note |
|---|---|---|---|
| FFmpeg (`ffmpeg`, `ffprobe`) | `ingest`, `rhythm`, `loudness_energy` (decode) | LGPL-2.1+ / GPL-2+ depending on the build | Run as a **subprocess** of the worker, never linked. Use an LGPL build (the Debian `ffmpeg` package is GPL-enabled; fine for a server-side subprocess, but note it for any redistributed desktop sidecar, Q9) |
| Chromaprint (`fpcalc`) | `ingest` fingerprint | LGPL-2.1 | Subprocess, same reasoning |
| `mir_eval` | eval harness only | MIT | Not shipped in the worker image path that serves jobs |

## Evaluated and rejected

| Model | Why |
|---|---|
| madmom (RNN beat tracker + DBN) | Its pretrained models are distributed under CC BY-NC-SA 4.0 (non-commercial). Not re-verified in this WP because it is **not used**; Beat This! needs no DBN (`dbn=False`) |

## Weight-free stages (no model, deliberately)

| Stage | Why there is no row | Reference |
|---|---|---|
| `analysis.structure` (WP-1.4, `structure@ssm-novelty-1`) | The v1 segmenter is **weight-free** — self-similarity + Foote novelty + repetition grouping on beat-synchronous chroma/timbre/energy, NumPy/SciPy only. No weights, no licence question, no GPU. A neural All-In-One-class upgrade is planned once a licence-clear checkpoint can be evaluated on the eval set (Q44). | [ADR-0010](../../specs/decisions/ADR-0010-structure-segmentation.md) |
| `analysis.stem_activity` (WP-1.6) | Gated RMS (−45 dBFS, 250 ms hop) — arithmetic on the stems, no model at all. | [04 §5.4](../../specs/04-analysis-pipeline.md) |
| `analysis.embed_*` fallback (WP-1.6, `model` `bragi-concept-basis-1`) | The **CI/runtime fallback** for the three embedding capabilities: a deterministic concept basis over DSP descriptors, NumPy only. Not semantic; every result it produces is flagged `lowConfidence`. The target CLAP model is pinned below but not downloaded here. | [ADR-0011](../../specs/decisions/ADR-0011-embeddings-and-tags.md) |
| `analysis.tag` zero-shot path (WP-1.6) | With no trained heads, genre/mood/instrument/descriptors/era are scored by cosine over the taxonomy prompts with the selected embedder; the result is `lowConfidence`. Trained heads replace genre/mood/instrument (see below). | [04 §6.2](../../specs/04-analysis-pipeline.md) |

## Planned (not yet in use)

## Embeddings & tagging (WP-1.6)

### `laion/larger_clap_music` — the v1 embedding target (not loaded in this environment)

| Field | Value |
|---|---|
| Task | Joint audio–text embedding for `analysis.embed_full`/`section_embed`/`stem_embed` and zero-shot `analysis.tag` (04 §6.1, §6.2) |
| Architecture | CLAP (SwinTransformer audio + RoBERTa text), 512-d joint embedding |
| Source | https://huggingface.co/laion/larger_clap_music |
| Pinned revision | **PENDING** — the commit to pin has not been recorded yet (the PyPI/Git SHA-256 below likewise) |
| `model.safetensors` SHA-256 | **PENDING** — the weights could not be fetched in the WP-1.6 environment; the loader refuses to run until this and `BRAGI_CLAP_SHA256` are set (04 §9) |
| Code licence | MIT (`laion_clap`, https://github.com/LAION-AI/CLAP); Apache-2.0 for the `transformers` loader |
| **Weights licence** | **Apache-2.0** (the Hugging Face model card states `apache-2.0`, verified 2026-10-19) |
| Commercial use | **yes** on weights licence grounds; the training-data terms still fall under the general Q6 review |
| Runtime extra | `clap` (`torch` + `transformers`), **not** installed in the default sync or the CPU gate; the worker image would need `uv sync --extra clap` when the checkpoint is added (Q68) |
| Date verified | 2026-10-19 (licence only; the checkpoint bytes were not downloaded) |

The loader (`bragi_analysis.embedding.clap.CLAPEmbedder`) reads `BRAGI_CLAP_CHECKPOINT` (or
`BRAGI_MODELS_DIR/clap`), verifies `model.safetensors` against `BRAGI_CLAP_SHA256`, imports
`torch`/`transformers` lazily and **never downloads** (`HF_HUB_OFFLINE=1`). Until the hash is
recorded it raises `EmbedderUnavailableError`, and the capabilities fall back to the
concept-basis embedder.

### Tag heads (trained by us — data, not a downloaded model)

`analysis.tag` loads `<category>.npz` MLP heads from `BRAGI_TAG_HEADS`
(`bragi_analysis.tagging.zeroshot.load_heads`). They are **not** shipped: they are trained by
`services/workers/embed/training/train_heads.py` on CLAP embeddings of **MTG-Jamendo**
(`mtg-jamendo/mtg-jamendo-dataset`), a CC-licensed dataset that must be re-checked per subset for
the exact licence (CC-BY / CC-BY-SA / CC-BY-NC / CC0) before commercial use. No audio, heads or
dataset are committed here. Owner actions: fetch the data, train, calibrate per-label thresholds
and run the top-3 genre gate (Q67).

## Separation (WP-1.3)

Machine-readable pins live in
[`analysis/src/bragi_analysis/separation/models_lock.json`](analysis/src/bragi_analysis/separation/models_lock.json).
The Docker build runs `python -m bragi_analysis.separation.weights /opt/bragi/models`, which
downloads each file at the pinned revision and refuses a SHA-256 mismatch; the worker loads from
`BRAGI_MODELS_DIR` (default `/opt/bragi/models`) and re-verifies the hashes before loading. A test
(`test_every_pinned_hash_is_recorded_in_models_md`) fails if this table and the lock file drift.
The choice is argued in [ADR-0004](../../specs/decisions/ADR-0004-separation-model.md) (Proposed).

### `htdemucs_6s` — v1 default (stage version `htdemucs_6s-1`)

| Field | Value |
|---|---|
| Task | Music source separation: `drums, bass, other, vocals, guitar, piano` at 44.1 kHz |
| Architecture | Hybrid Transformer Demucs, 1 model in the bag, 27.4 M parameters, 52.3 MiB of safetensors (2 bytes per parameter) |
| Source | https://huggingface.co/adefossez/HTDemucs-6s |
| Pinned revision | `3c5ee475be622df764938de97e4281a7b07ffa58` |
| `5c90dfd2.safetensors` SHA-256 | `d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411` |
| `htdemucs_6s.yaml` SHA-256 | `207405151270af8fd81c2373c25d27950916682ac91dca7884a11ce13dad6f58` |
| Code licence | MIT (`demucs` 4.1.0, https://github.com/adefossez/demucs, copyright Meta Platforms) |
| **Weights licence** | **Not stated separately.** The Hugging Face repository has no `license` field and no licence file; the upstream README says only "Demucs is released under the MIT license". Treated as MIT. |
| Training data | MUSDB18-HQ plus an extra set of 800 songs (upstream README). MUSDB18 is licensed for non-commercial research use; the 800-song set is not documented. |
| Commercial use | **unclear** — flagged. MIT covers the weights as published, but the training-data terms are not stated; see Q32 in [15](../../specs/15-open-questions.md). |
| Quality caveat | Upstream says `guitar` is "okay" and `piano` has "a lot of bleeding and artifacts". |
| Date verified | 2026-10-19 |

### `htdemucs` — 4-source fallback and bake-off baseline (stage version `htdemucs-1`)

| Field | Value |
|---|---|
| Task | `drums, bass, other, vocals` at 44.1 kHz |
| Source | https://huggingface.co/adefossez/HTDemucs |
| Pinned revision | `cbc8a9b1a87023b7fd74e7b3412e6321c0eab003` |
| `955717e8.safetensors` SHA-256 | `d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd` |
| `htdemucs.yaml` SHA-256 | `239c445d0b14454d541ad8bd9bb271c9e536d267e8a4625208744cbb2e7bb66c` |
| Code licence | MIT |
| **Weights licence** | Not stated separately (as above); treated as MIT |
| Commercial use | **unclear** — flagged (same training data) |
| Date verified | 2026-10-19 |

### Runtime libraries added by WP-1.3 (not models, recorded because 13 §4 asks for no licence-unclear dependency)

| Package | Licence | Notes |
|---|---|---|
| `torch` 2.14 | BSD-3-Clause (and bundled Apache-2.0 / MIT parts) | the `models` dependency group only |
| `demucs` 4.1.0 | MIT | the `models` group only |
| `numpy`, `scipy`, `soundfile`, `pyyaml` | BSD-3-Clause / BSD / MIT | `soundfile` loads `libsndfile` (LGPL-2.1, dynamically linked, shipped in its wheel) |
| `lameenc` (pulled in by `demucs`) | **LGPL-3.0-or-later** | an MP3 encoder `demucs` imports for its own CLI; the worker never calls it. Dynamically linked via the wheel. Flagged for the owner (Q32) |
| `einops`, `julius`, `safetensors`, `sphn`, `tqdm`, `huggingface-hub` | MIT / Apache-2.0 / MPL-2.0 | `demucs` dependencies; `huggingface-hub` is not used at runtime (weights load from disk) |

### Evaluated in the bake-off but **not adopted** (no weights pinned)

See ADR-0004. Listed so the licence findings are not lost.

| Model | Code | Weights | Finding |
|---|---|---|---|
| `htdemucs_ft` (4 fine-tuned models) | MIT | not stated separately | ~4x the compute of `htdemucs`; not run to completion, see ADR |
| Mel-Band RoFormer vocal checkpoint (`KimberleyJSN/melbandroformer`) | MIT (`bs-roformer`, lucidrains) | Hugging Face tag `license:mit` | see ADR-0004 for what was and was not measured |

## Harmony (WP-1.5)

The v1 harmony stage is **weight-free**: `analysis.harmony` matches beat-synchronous chroma against
in-repo chord templates (no learned weights, no `torch`), so there is **no row to pin** here and
nothing is downloaded at runtime. The choice and the neural seam are in
[ADR-0008](../../specs/decisions/ADR-0008-chord-detection.md).

Candidate neural chord recognisers to evaluate on the owner's eval set (not adopted, no weights
pinned): BTC (Bidirectional Transformer for Chord recognition) and similar transformer recognisers
(code licence to confirm; weights licence to verify), and **madmom chord models** — rejected for the
same reason as its beat models above (CC BY-NC-SA 4.0 non-commercial weights). A checkerboard of
permissively licensed key/chord tools should be verified before any commercial launch (Q64).

