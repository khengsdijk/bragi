# bragi-analysis

The analysis workers — how a dropped file becomes a song you can see
([04-analysis-pipeline.md](../../../specs/04-analysis-pipeline.md)).

| Capability | Produces | Filled by | Quality gate |
|---|---|---|---|
| `analysis.ingest` | 48 kHz 24-bit FLAC working copy, fingerprint, peak pyramid, rejects | WP-1.2 (**done**) | correct error codes for corrupt/too-long input |
| `analysis.rhythm` | beats, downbeats, tempo map | WP-1.2 (**done**; gate pending the eval set) | beat F ≥ 0.85 |
| `analysis.loudness_energy` | R128 loudness, energy curve | WP-1.2 (**done**) | documented hop and range |
| `separate` | stems + residual | WP-1.3 | Σ stems + residual nulls ≤ −60 dBFS; 4 min < 40 s on the reference GPU |
| `structure` | sections, repeat groups | WP-1.4 | boundary hit-rate ≥ 0.70, label accuracy ≥ 0.60 |
| `harmony` | key, chords, progression fingerprint | WP-1.5 | chords ≥ 0.70, key ≥ 0.80, key-invariant fingerprint |
| `tag`, `describe` | taxonomy tags, plain-language description | WP-1.6, WP-1.7 | top-3 genre ≥ 0.70; 0 hard failures, grounding post-check |
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
  capabilities/       one module per capability (CAPABILITY, ParamsModel, run)
  config/energy.toml  energy weights (04 §5.5)
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

## Eval

`pnpm eval:analysis` reads `fixtures/eval/manifest.json`, scores every track whose audio was fetched
by `scripts/fetch-eval.sh`, and writes `reports/analysis-<date>.md`. With no eval set the rhythm gate
is `PENDING` — see [`fixtures/eval/README.md`](../../../fixtures/eval/README.md).
