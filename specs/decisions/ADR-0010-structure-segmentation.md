# ADR-0010 — Structure segmentation: self-similarity + novelty + repetition grouping (weight-free v1)

- **Status:** Proposed (the machinery and the synthetic proof are measured; the model choice is provisional until the owner's eval set can decide real-music accuracy)
- **Date:** 2026-10-19
- **Decider:** Koen
- **Work package:** WP-1.4

## Context

[04 §5.2](../04-analysis-pipeline.md) asks for section boundaries and functional labels "using an
All-In-One-class model or a boundary model + label classifier", with boundaries snapped to the
nearest downbeat and then to a 2-/4-bar phrase grid, and with repetitions detected "via a
self-similarity matrix of beat-synchronous chroma + embeddings". The eval gates are a boundary
hit-rate ≥ 0.70 and label accuracy ≥ 0.60, plus a `repeatGroup` check on songs with ≥ 2 choruses
([04 §8](../04-analysis-pipeline.md), [12](../12-roadmap.md)).

Three constraints shape the choice:

- **No permissive labelled training data** is available in this environment to train a boundary
  model or a label classifier.
- **No CUDA** (macOS arm64), and the eval set does not exist yet ([15](../15-open-questions.md) Q32),
  so nothing can be calibrated or gated against real music here.
- A **new major dependency needs an ADR** ([13 §1](../13-agent-guide.md)), and model weights must
  be licence-clear and pinned ([04 §9](../04-analysis-pipeline.md)).

An `analysis.structure` capability must still ship: it feeds the canvas sections and
`analysis.apply`'s `sections` effect ([02 §6](../02-song-model.md)).

## Options considered

| Option | Code | Weights | Deps added | Verdict |
|---|---|---|---|---|
| **All-In-One** (`mir-aidj/all-in-one`) | MIT | **No weights licence is stated** anywhere in the repo (treated as *unclear*) | `natten` (CUDA build friction on CPU/macOS), `demucs`, `madmom` (BSD code, but its own models are non-commercial), `librosa`, `hydra` | Not integrated in v1. The unclear weights licence alone blocks a commercial path; the dependency drag and the CUDA-oriented build make it a poor fit for the CPU gate. Kept as the v2 upgrade target (Q44). |
| Train a boundary model + label classifier ourselves | ours | n/a | `torch` | Out of scope: no permissive labelled section data here, and training belongs to a data WPs, not WP-1.4. |
| **Self-similarity + novelty segmentation + repetition grouping** on beat-synchronous chroma/timbre/energy (Foote 2000; McFee & Ellis / Serra et al. lineage) | ours | none | none (NumPy/SciPy, already deps) | **Chosen for v1.** It *is* the machinery 04 §5.2 prescribes for `repeatGroup`, applied to boundaries as well; it needs no weights, so it runs on CPU in `pnpm verify` and can decide a gate the moment real music exists. |

## Decision

1. **v1 `structure` is weight-free.** `stageVersion` is `structure@ssm-novelty-1`. The pipeline is:
   beat-synchronous chroma + log-mel-DCT timbre + RMS energy
   (`structure/features.py`) → cosine self-similarity matrix + Foote checkerboard novelty
   (`structure/novelty.py`) → boundary peaks, snapped to downbeats and the 2-/4-bar phrase grid
   (`structure/snap.py`) → **repeat groups** by aligned section similarity + average-linkage
   clustering (`structure/grouping.py`) → heuristic functional labels (`structure/labels.py`,
   `structure/pipeline.py`).
2. **The labeller speaks the All-In-One vocabulary** (`intro verse chorus bridge inst solo break
   outro`) and maps it to `SectionKind` through `config/structure_labels.json`
   (`inst → interlude`, `break → breakdown`, `start`/`end` → merged into a neighbour). A neural
   segmenter that speaks the same words can replace the segmenter *and* the labeller later without
   touching grouping, snapping or the contract (Q44).
3. **Grouping, snapping and the blob contract are model-independent.** Whatever produces the
   boundaries, `repeatGroup` letters, downbeat/phrase snapping, the `StructureResult` blob and the
   `analysis.apply` `sections` effect stay the same.
4. **Graceful degradation, never a job failure.** Too short, no pulse, digital silence or a
   doubtful beat grid (rhythm `confidence` < 0.4) publish one `custom`/`unknown` section flagged
   `lowConfidence` ([04 §10](../04-analysis-pipeline.md)); only a genuinely misdecoded input is an
   error.
5. **The real gates are not claimed here.** With no eval set, the boundary/label/`repeatGroup`
   gates are `PENDING`; the synthetic songs prove the metrics, the snapping, the grouping and the
   wiring, and are reported as synthetic, never as the gate ([04 §8](../04-analysis-pipeline.md)).

## Consequences

- **Positive:** no model weights, no licence question, no GPU; the stage runs in `pnpm verify` and
  on any CPU. It lands the `repeatGroup` mechanism 04 §5.2 asks for, which a later model can reuse.
- **Positive:** the model vocabulary → `SectionKind` mapping and the bounding/snapping/grouping
  layers are isolated, so swapping in an All-In-One-class segmenter is a new module plus a
  `stageVersion` bump (Q44).
- **Negative:** heuristic labels are *guesses from recurrence, loudness and position*, not
  recognition; the ≥ 0.60 label-accuracy gate is exactly the measurement of how often the guess is
  right, and it cannot be evaluated without the eval set.
- **Negative:** the label-accuracy and `repeatGroup` constants (`SAME_MATERIAL`, the energy tie)
  are untuned on real music and are listed for calibration (Q45).
- **Negative:** a spurious beat at t ≈ 0 in a **fallback** tracker's grid on a song with a silent
  lead-in produces one extra section ([15](../15-open-questions.md) Q47); the exact-grid (and the
  v1 Beat This! path) do not show it.
- **Open:** whether to adopt All-In-One (or another segmenter) is decided by the eval-set bake-off
  once the set exists (Q44); the `config/structure_labels.json` location moves to the real
  `taxonomy.json` when WP-1.6 creates it (Q46).
