# ADR-0007 — Beat tracking: Beat This! on optional CPU-capable PyTorch, with a weight-free fallback

- **Status:** Proposed (the technical result is measured; the owner signs off the dependency)
- **Date:** 2026-10-19
- **Decider:** Koen
- **Work package:** WP-1.2

## Context

[04 §5.1](../04-analysis-pipeline.md) names **Beat This!** as the v1 candidate for beat and
downbeat tracking, with All-In-One as the alternative, and gates it at beat F >= 0.85 on the eval set
([04 §8](../04-analysis-pipeline.md)). Beat This! is a PyTorch model, so using it adds `torch` to the
Python workers — a major dependency that [13 §1](../13-agent-guide.md) says needs an ADR. WP-1.3
(separation) will add `torch` as well, so the *dependency* is shared; this ADR records the beat
tracker choice and the way it is wired.

Constraints: GPU code
must also run on CPU ([13 §3](../13-agent-guide.md)) so the CPU gate stays meaningful; weights are
pinned by hash and never downloaded at runtime; and `pnpm verify` must stay fast.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Beat This!** (`beat-this` 1.1, CPJKU) | State of the art at ISMIR 2024; beats and downbeats in one pass; no DBN post-processing needed (`dbn=False`), so no madmom; runs on CPU (measured below) | Needs `torch` |
| madmom (RNN + DBN) | Classic baseline | Older; a candidate for the beat bake-off against Beat This! |
| All-In-One (beats + downbeats + segments) | Jointly gives structure ([04 §5.2](../04-analysis-pipeline.md)) | Heavier; depends on madmom's DBN for its beat output; its fit belongs to WP-1.4's structure bake-off |
| Own DSP tracker only (flux + autocorrelation + DP) | No weights, no torch | Cannot reach 0.85 on real music; no robust downbeats |

## Decision

1. **Beat This! `final0` is the v1 beat tracker**, behind a `BeatTracker` protocol
   (`bragi_analysis.trackers`), so swapping it is a new module plus a `stageVersion` bump
   (`rhythm@beat_this-final0-1`).
2. **`torch` and `beat-this` live in an optional `ml` extra** of `bragi-analysis` (re-exported by the
   workspace root). The default `uv sync` — and therefore `pnpm verify` — never installs them; the
   worker image opts in with `--extra ml` and the GPU eval runs `pnpm eval:analysis:ml`.
3. **Weights are pinned and verified.** `final0.ckpt` has SHA-256
   `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`. The loader refuses any file
   with a different hash, and the checkpoint is read with `torch.load(..., weights_only=True)`.
   Nothing is downloaded at runtime; the image build fetches and verifies the file.
4. **A weight-free DSP tracker is the fallback and the test double.** `rhythm` with `tracker: auto`
   uses Beat This! when it can run and otherwise the DSP tracker, logging a warning
   ([04 §1.3](../04-analysis-pipeline.md): stages degrade gracefully). The eval harness refuses to let
   the fallback decide the gate.
5. **The F >= 0.85 gate is not claimed here.** It needs the eval set, which does not exist yet
   (WP-1.2 delivers the harness; the gate is `PENDING`).

## Consequences

- Positive: a beat model that runs on CPU. Measured on an M-series Mac CPU, a 4-minute
  stereo file takes **5.5 s** for `rhythm` (Beat This!), against a **0.5 s** DSP fallback. The whole `quick`-profile trio (`ingest` + `loudness_energy` +
  `rhythm`) is ~9 s on a laptop CPU, inside the < 15 s budget of
  [04 §3](../04-analysis-pipeline.md) (which assumes a GPU).
- Positive: the default developer loop and `pnpm verify` do not pay for torch.
- Negative: two code paths for the same stage. Mitigated by one shared post-processing module
  (`rhythm_post`), so the published contract does not depend on the tracker, and by tests that run the
  fallback everywhere and Beat This! when `BRAGI_TEST_WEIGHTS=1`.
- Negative: Beat This! produces no confidence, so `confidence` is a regularity heuristic
  ([04 §5.1](../04-analysis-pipeline.md) note); revisit when the eval set can calibrate it.
