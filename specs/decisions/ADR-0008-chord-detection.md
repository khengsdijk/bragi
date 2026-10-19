# ADR-0008 — Chord and key detection: weight-free chroma templates, neural backend deferred

- **Status:** Proposed (the machinery and the key-invariance test pass; the owner signs off the
  approach and the eval gates cannot be run without the eval set)
- **Date:** 2026-10-19
- **Decider:** Koen
- **Work package:** WP-1.5

## Context

[04 §5.3](../04-analysis-pipeline.md) asks for key estimation from beat-synchronous chroma of the
harmonic stems, a **neural chord recogniser** ("candidate: a transformer chord model, licence
verified in WP-1.5"), roman numerals and a key-invariant `progressionFingerprint`, and it cautions
that "some well-known key/chord tools are AGPL/GPL or non-commercial". The gate is chord accuracy
(majmin) ≥ 0.70 and key accuracy ≥ 0.80 on the eval set ([04 §8](../04-analysis-pipeline.md)).

Constraints: no CUDA GPU here (13 §3); the eval set does not exist yet (Q32), so no candidate can be
compared on real music; weights must be permissively licensed, pinned by hash and never downloaded
at runtime (04 §9); and `pnpm verify` must stay fast and CPU-only.

## Options considered

| Option | Code licence | Weights licence | Pros | Cons |
|---|---|---|---|---|
| **Weight-free chroma templates + Viterbi (adopted v1)** | ours (in-repo) | none | No weights, no torch, CPU-only, deterministic, permissive; testable on synthetic signals with exact ground truth; key-invariance holds by construction | Accuracy on real music unmeasured; root-position templates only (no slash bass, limited tension); the gates stay PENDING |
| BTC (Bidirectional Transformer for Chord recognition) | MIT | to verify | Strong majmin accuracy in the literature | Needs `torch` plus a pinned checkpoint; weights licence to verify; only worth adopting once the eval set can compare it |
| ChordFormer / Jamendo-trained chord models | to verify | often CC-BY-NC or unclear | Possibly better on pop/rock | A non-commercial weights licence is rejected by 04 §9 |
| madmom chord models (CNN + DBN) | BSD-3-Clause | CC BY-NC-SA 4.0 (non-commercial) | Classic, well documented | **Rejected**: non-commercial weights — the same reason madmom was rejected for beats in [ADR-0007](ADR-0007-beat-tracking.md) |
| `librosa` chroma + templates | ISC | none | Familiar API | A new major dependency for what the existing STFT (`dsp/features.py`) already provides |

## Decision

1. **The v1 harmony recogniser is weight-free**: beat-synchronous pitch-class chroma matched against
   a bank of root-position chord templates, decoded with a change-penalised Viterbi pass; key from
   the Krumhansl-Schmuckler profiles, refined by the decoded chords. Stage version
   `harmony@chroma-template-1`.
2. **No new dependency.** Chroma reuses `dsp/features.stft_magnitude`; the decoders are
   `numpy`/`scipy`; the synthetic proof uses `mir_eval.chord` (already a dependency).
3. **A `ChordRecognizer` protocol is the seam** (like `BeatTracker` in ADR-0007). Adopting a neural
   recogniser later is a new module inside `bragi_analysis.harmony`, a pinned checkpoint in
   `MODELS.md`, an optional uv extra and a `stageVersion` bump — the published `HarmonyResult` does
   not change.
4. **`progressionFingerprint` is the roman-numeral sequence with immediate repeats collapsed**
   (04 §5.3's example `i-VI-III-VII`). The numerals are relative to the key, so a transposed song
   gives the same fingerprint; this is proven by a test, not asserted.
5. **The ≥ 0.70 / ≥ 0.80 gates are not claimed here.** They need the eval set (Q32); the synthetic
   numbers prove the machinery only.

## Consequences

Positive: no weights to pin or download, runs on CPU in well under a second for a 4-minute song,
permissive throughout, deterministic and unit-testable; key-invariance is structural rather than
learned.

Negative / risks:

- **No accuracy number on real music.** The template bank is root-position only, so slash chords
  (`C/E`) and extended tensions are approximated; key confidence and key-change detection are
  heuristics (a scaled margin over the runner-up, and a two-window run requirement) that the eval
  set should calibrate.
- Inharmonic content (noise, heavy percussion leaking into the fallback path) can still yield a
  low-confidence chord; the result carries `lowConfidence` so the UI can mark it uncertain
  (04 §10).
- The **orchestrator passes only `assets.source`** today (Q33), so in the running system harmony sees
  the full mix, not the harmonic stems; the capability prefers stems when they are provided.

## To make this Accepted (eval-set bake-off, owner's set)

1. Score `harmony@chroma-template-1` on `fixtures/eval/` with `mir_eval.chord.evaluate(...)["majmin"]`
   (chord accuracy, duration-weighted) and a key-accuracy count, and record the gate verdicts.
2. Compare at least one loading neural recogniser (BTC or similar) with a permissively licensed,
   hash-pinned checkpoint; pick the winner and set the stage version.
3. Check the weights licence of any adopted model with the owner (Q6/Q40).
4. Update this ADR with the numbers and set Accepted.
