# bragi-analysis

The analysis workers — how a dropped file becomes a song you can see
([04-analysis-pipeline.md](../../../specs/04-analysis-pipeline.md)).

| Capability | Produces | Filled by | Quality gate |
|---|---|---|---|
| `analysis.ingest` | 48 kHz 24-bit FLAC working copy, fingerprint, peak pyramid, rejects | WP-1.2 (**done**) | correct error codes for corrupt/too-long input |
| `analysis.rhythm` | beats, downbeats, tempo map | WP-1.2 (**done**; gate pending the eval set) | beat F ≥ 0.85 |
| `analysis.loudness_energy` | R128 loudness, energy curve | WP-1.2 (**done**) | documented hop and range |
| `separate` | stems + residual | WP-1.3 | Σ stems + residual nulls ≤ −60 dBFS; 4 min < 40 s on the reference GPU |
| `analysis.structure` | sections, labels, repeat groups | WP-1.4 (**done**; gates pending the eval set) | boundary hit-rate ≥ 0.70, label accuracy ≥ 0.60, chorus `repeatGroup` ≥ 80 % (`structure@ssm-novelty-1`, weight-free — ADR-0010) |
| `harmony` | key, chords, progression fingerprint | WP-1.5 (**done**; gates pending the eval set) | chords ≥ 0.70, key ≥ 0.80, key-invariant fingerprint (`template-1`, weight-free — ADR-0008) |
| `stem_activity` | per-stem active regions + per-section presence | WP-1.6 (**done**) | gated RMS at −45 dBFS, 250 ms hop (04 §5.4) |
| `embed_full`, `section_embed`, `stem_embed` | 512-d L2-normalised CLAP-family vectors | WP-1.6 (**machinery done**; CLAP + gates pending) | 10 s/5 s windows, pooled; target `laion-clap-music-1`, fallback `bragi-concept-basis-1` (ADR-0011) |
| `tag` | scored taxonomy labels | WP-1.6 (**machinery done**; heads + gate pending) | top-3 genre ≥ 0.70; `"drums"` stem ranking ≥ 90 % (04 §6.2, §8) |
| `describe` | plain-language description | WP-1.7 | 0 hard failures, grounding post-check |
| `drum_split`, `transcribe`, `lyrics` | deep profile | WP-6.2 (transcribe may land in WP-4.3) | — |

Capability names carry the `analysis.` prefix because that is what the orchestrator's DAG
(`services/api/src/jobs/dag.ts`) publishes (`jobs.analysis.<stage>.<priority>`).

## Layout

```
src/bragi_analysis/
  media.py            ffmpeg/ffprobe/fpcalc subprocesses; maps failures to error codes
  dsp/                loudness.py (BS.1770 / R128), features.py, energy.py
  trackers/           BeatTracker protocol; beat_this.py (torch, optional); dsp.py (fallback)
  rhythm_post.py      beats -> RhythmResult, shared by every tracker
  structure/          features, novelty, snap, grouping, labels, pipeline (04 §5.2, ADR-0010)
  harmony/            chroma, chords, key, pipeline (04 §5.3, ADR-0008)
  activity.py         per-stem gated RMS -> active regions + presence (04 §5.4)
  embedding/          Embedder seam, windowing/pooling, fallback + CLAP, pgvector store (04 §6.1)
  tagging/            taxonomy, zero-shot, MLP heads, TagResult assembly (04 §6.2)
  capabilities/       one module per capability (CAPABILITY, ParamsModel, run)
  config/             energy.toml (04 §5.5), structure_labels.json (04 §5.2),
                      taxonomy.json (generated), tag.toml (04 §6.2)
  evaluation/         eval harness + synthetic fixtures (pnpm eval:analysis)
```

## System binaries

`ffmpeg`, `ffprobe` and `fpcalc` (Chromaprint) must be on `PATH` (`brew install ffmpeg chromaprint`;
the worker image installs them). Tests that need them skip with a clear reason when they are missing.

## Models and the `ml` extra

Beat This! needs `torch`, which is **not** in the default environment (keeps `pnpm verify` fast).

```bash
uv sync --directory services/workers --extra ml
export BRAGI_BEAT_THIS_CHECKPOINT=/path/to/final0.ckpt     # SHA-256 pinned in ../MODELS.md
BRAGI_TEST_WEIGHTS=1 uv run --directory services/workers --extra ml pytest -k beat_this
pnpm eval:analysis:ml
```

Without the checkpoint, `rhythm` (`tracker: auto`) logs a warning and uses the DSP fallback.

## Models and the `clap` extra

The embedding/tagging capabilities prefer LAION-CLAP when a verified checkpoint is configured, and
fall back to the deterministic concept-basis embedder otherwise. CLAP is **not** in the default
environment (it would make `pnpm verify` need torch and weights).

```bash
uv sync --directory services/workers --extra clap
export BRAGI_CLAP_CHECKPOINT=/models/clap                   # a directory with model.safetensors
export BRAGI_CLAP_SHA256=<the pinned sha256, recorded in ../MODELS.md>
BRAGI_TAG_HEADS=/models/bragi-heads uv run --directory services/workers --extra clap pytest
```

The loader refuses an unverified checkpoint (04 §9) and never downloads weights. Trained tag heads
and the eval-set gates are the owner's (see [`docs/wp/1.6.md`](../../../docs/wp/1.6.md) and
[`embed/training/`](../embed/training/)).

## Eval

`pnpm eval:analysis` reads `fixtures/eval/manifest.json`, scores every track whose audio was fetched
by `scripts/fetch-eval.sh`, and writes `reports/analysis-<date>.md`. It scores `rhythm` on every
track and `structure` on the tracks that carry a `labels.sections` file. With no eval set the rhythm,
structure, harmony, `tag` and embedding gates are all `PENDING` — see
[`fixtures/eval/README.md`](../../../fixtures/eval/README.md). The `tag` top-3 genre gate and the
`"drums"` stem-ranking gate additionally need trained heads and per-stem references.
