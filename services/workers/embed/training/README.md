# Tag-head training (WP-1.6, [ADR-0011](../../../../specs/decisions/ADR-0011-embeddings-and-tags.md))

This directory trains the small MLP heads `analysis.tag` loads from `BRAGI_TAG_HEADS` to label
genre, mood and instrument from CLAP song embeddings (04 §6.2). Descriptors and era are always
zero-shot and are **not** trained here.

**Nothing in here was run for WP-1.6**: this environment has no GPU, no CLAP weights and no
labelled dataset, so the heads, their per-label thresholds and therefore the top-3 genre gate
(≥ 0.70) are the owner's to produce. The script and notebook exist so the run is reproducible.

## Dataset

The v1 target is **MTG-Jamendo** (`mtg-jamendo/mtg-jamendo-dataset`), whose audio is CC-licensed
and whose tags cover genres, moods and instruments. Its licence must be re-checked per subset
before use: the dataset is a mixture of CC-BY, CC-BY-SA, CC-BY-NC and CC0 tracks, so keep only the
licences the product is comfortable with (see Q6 in `specs/15-open-questions.md`). No audio is
committed to this repository.

Prepare a JSONL file, one line per clip:

```json
{"path": "audio/1234.mp3", "genres": ["electronic", "house"], "moods": ["energetic"],
 "instruments": ["drums", "synth"]}
```

Label ids must be taxonomy ids (`packages/schemas/analysis/taxonomy.json`); unknown ids are
dropped with a warning. Parents are **not** expanded automatically — decide per category whether
a `house` clip should also count as `electronic` (the script accepts a label set as given).

## Commands

```bash
# 1. CLAP weights, pinned by hash (see services/workers/MODELS.md)
export BRAGI_CLAP_CHECKPOINT=/models/clap
export BRAGI_CLAP_SHA256=<the pinned sha256 of model.safetensors>
uv sync --directory services/workers --extra clap

# 2. Train the heads (numpy; embeddings come from the CLAP embedder)
uv run --directory services/workers --extra clap \
  python services/workers/embed/training/train_heads.py \
  --dataset /data/jamendo.jsonl \
  --taxonomy packages/schemas/analysis/taxonomy.json \
  --out /models/bragi-heads \
  --epochs 40 --hidden 256 --seed 0

# 3. Evaluate the top-3 genre gate on the eval set (once it exists)
#    BRAGI_TAG_HEADS=/models/bragi-heads then score `analysis.tag` against the hand labels.

# 4. At serving time
export BRAGI_TAG_HEADS=/models/bragi-heads     # analysis.tag picks the heads automatically
```

## What it writes

One `<category>.npz` per trained category (`genres`, `moods`, `instruments`) with keys
`labels`, `w1`, `b1`, `w2`, `b2` — exactly what `bragi_analysis.tagging.zeroshot.load_heads`
reads. `heads.ipynb` is the same run as a notebook, with the eval printout.
