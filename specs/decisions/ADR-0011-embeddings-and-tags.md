# ADR-0011 — Embeddings and tags: CLAP as the target, a deterministic concept-basis fallback

- **Status:** Proposed (the target model is chosen on licence and contract grounds; the fallback and
  the machinery are measured, but real-music accuracy is unmeasured — no eval set, no weights)
- **Date:** 2026-10-19
- **Decider:** Koen
- **Work package:** WP-1.6

## Context

[04 §6.1](../04-analysis-pipeline.md) requires a **CLAP-family joint audio–text** embedding model
producing 512-d L2-normalised vectors, because a shared audio–text space is what powers text search
("sad piano intro") and zero-shot tagging. [04 §6.2](../04-analysis-pipeline.md) builds tagging on
those embeddings: small **MLP heads** for genre/mood/instrument plus **zero-shot similarity** for
descriptors, over a controlled `taxonomy.json`. The gates are top-3 genre agreement ≥ 0.70 and
`"drums"` ranking drum stems first for ≥ 90 % of eval songs ([04 §8](../04-analysis-pipeline.md),
[12](../12-roadmap.md)).

Constraints in this environment ([13 §6](../13-agent-guide.md)):

- **No CUDA** and **no downloadable weights** (Hugging Face / Docker Hub pulls are blocked), so no
  real embedding can be run or measured here.
- **No eval set** ([15](../15-open-questions.md) Q32) and **no permissively labelled tagging
  dataset** available locally, so no head can be trained or calibrated here.
- `pnpm verify` must stay a fast, CPU-only, torch-free gate.
- A **new major dependency needs an ADR** (this one), and every model's weights must be
  licence-clear and hash-pinned ([04 §9](../04-analysis-pipeline.md), [13 §1](../13-agent-guide.md)).

Text search, tagging and the Universe all depend on this WP, so *something* must ship.

## Options considered

| Option | Code | Weights | Deps | Verdict |
|---|---|---|---|---|
| **LAION-CLAP `laion/larger_clap_music`** | MIT (`laion_clap`) / Apache-2.0 (`transformers`) | **Apache-2.0** (HF model card, verified 2026-10-19) | `torch`, `transformers` (optional extra) | **The v1 target.** Joint audio–text, 512-d, music-trained, permissive weights. Not runnable here (no weights); behind a hash-pinned loader. Q6 still governs the commercial decision. |
| **MERT / MuQ** (music-representation) | varies | several checkpoints are **non-commercial** | `torch` | Rejected for v1; kept for a WP-3.1 "sounds-like" spike (04 §6.1). No audio–text space, so it cannot do text search or zero-shot tagging. |
| **Train a CLAP from scratch** | ours | n/a | `torch` | Out of scope: no data, no GPU. |
| **Deterministic concept-basis embedder** (this WP) | ours (NumPy only) | none | none | **The CI/runtime fallback.** Not a semantic model: it proves the windowing, pooling, storage and tagging machinery and keeps `pnpm verify` torch-free. Never claimed as product quality. |
| **`madmom`-style or other tagging checkpoints** | mixed | often CC BY-NC | — | Rejected on the same licence grounds as ADR-0007/0008. |

## Decision

1. **`Embedder` is a protocol** (`embedding/protocol.py`: `model`, `dim`, `embed_audio`,
   `embed_texts`) with two implementations, selected by a capability param:
   - `CLAPEmbedder` — the v1 **target** (`model` `laion-clap-music-1`). It loads LAION-CLAP
     `laion/larger_clap_music` from `BRAGI_CLAP_CHECKPOINT` / `BRAGI_MODELS_DIR`, verifies the
     SHA-256 pin, imports `torch`/`transformers` **lazily** and **never downloads**
     (`HF_HUB_OFFLINE=1`, 04 §9). The exact bytes, the pinned commit and the SHA-256 are owner
     actions; until they are recorded the loader refuses to run.
   - `FallbackEmbedder` — `model` `bragi-concept-basis-1`, deterministic and NumPy-only. Each
     taxonomy concept owns a fixed pseudo-random unit vector in R^512 (seeded from its id) and a
     hand-written audio profile over interpretable DSP descriptors (band energies, onset/transient
     strength, spectral flatness/centroid, dynamic range). An audio vector is the L2-normalised
     activation-weighted sum of the concept basis; a text vector is the same sum for the concepts
     its keywords hit. In 512-d the basis vectors are near-orthogonal, so cosine similarity tracks
     **concept overlap**, which is enough to make the `"drums"`-ranking metric and the zero-shot
     path executable without weights.
2. **Windowing is 10 s with a 5 s hop**, each window overlap-weighted by its coverage of the
   requested scope, summed and L2-normalised; that one primitive implements song, section and
   stem-active-region pooling (formalises Q16's embedding part).
3. **Tagging uses MLP heads when present** (`BRAGI_TAG_HEADS`, a `.npz` per category) and the
   **zero-shot cosine over taxonomy prompts** otherwise, flagging `lowConfidence`. Descriptors and
   era are always zero-shot. The heads are trained by `services/workers/embed/training/` on
   MTG-Jamendo (CC) CLAP embeddings — not run here, documented as owner actions.
4. **Storage is Postgres/pgvector** (05 §5): an HNSW index migration plus a store behind the
   per-job `storeEmbeddings` flag (default off), so the CPU gate never touches Postgres.
5. **The gates are not claimed.** With no weights and no eval set, both acceptance criteria are
   `PENDING`; the synthetic proofs are reported as synthetic ([04 §8](../04-analysis-pipeline.md)).

## Consequences

- **Positive:** the whole WP lands and is testable in `pnpm verify` with no GPU, no weights and no
  torch; swapping in CLAP is a `stageVersion`/`model` change plus a pinned checkpoint, not a
  rewrite; the contract (`EmbeddingResult`, `TagResult`) is model-independent.
- **Positive:** the licence position is clean in the target: Apache-2.0 weights, MIT/both code, and
  the fallback has no licence question at all.
- **Negative:** the fallback is **not** semantic — it recognises a handful of hand-written audio
  concepts, so its tags and rankings say nothing about real music. Every result carries
  `bragi-concept-basis-1` and a low-confidence flag so nothing is mistaken for CLAP output.
- **Negative:** until the owner supplies the checkpoint (and its hash), the eval set and trained
  heads, the two gates cannot be decided and text search / zero-shot tagging stay unproven on real
  audio (Q32/Q17).
- **Open:** whether the CLAP checkpoint is trained on data whose terms a commercial launch is
  comfortable with (Q6); the MERT/MuQ secondary embedding is a WP-3.1 spike.
