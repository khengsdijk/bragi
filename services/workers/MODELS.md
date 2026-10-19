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

## Planned (not yet in use)

Harmony, embeddings and tagging models add their rows with their work
packages.

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

