# bragi-embed

Embeddings and projection: the machinery behind the Universe
([04 §5.4, §6](../../../specs/04-analysis-pipeline.md),
[08-universe.md](../../../specs/08-universe.md)).

- CLAP audio embeddings at song, section and stem scope, plus text embeddings for search.
- Trained MLP tag heads (training script and reproducible notebook live in `training/`).
- Zero-shot descriptors, pgvector storage.
- The library map projection, clustering, cluster naming and constellation edges.

Gates: top-3 genre agreement ≥ 0.70, and the text query "drums" ranks drum stems above other stems
for ≥ 90% of eval songs (WP-1.6).

**Status:** the embedding/tagging **capabilities** ship inside `services/workers/analysis`
(`analysis.embed_full`, `analysis.section_embed`, `analysis.stem_embed`, `analysis.tag`) — they are
analysis stages in the [04 §2](../../../specs/04-analysis-pipeline.md) DAG, so they run on the
analysis worker, not here. This package owns the **training** of the tag heads in `training/` and,
from WP-3.2 on, the projection/constellations.

## What is where

| Piece | Location |
|---|---|
| Embedder seam (`Embedder`, `select`, `CLAPEmbedder`, `FallbackEmbedder`, windowing, pooling, pgvector store) | `services/workers/analysis/src/bragi_analysis/embedding/` |
| Tagging (taxonomy, zero-shot, MLP heads, `TagResult` assembly) | `services/workers/analysis/src/bragi_analysis/tagging/` |
| Capabilities | `services/workers/analysis/src/bragi_analysis/capabilities/{embed_full,section_embed,stem_embed,tag}.py` |
| Taxonomy | `packages/schemas/analysis/taxonomy.json` (copied into the worker by `pnpm schemas:gen`) |
| Head training | `training/` (this package) |

## Status of the gates

The v1 target embedder is LAION-CLAP `laion/larger_clap_music` (Apache-2.0 weights), pinned in
`../MODELS.md`; the weights are **not** downloadable in the implementation environment, so a
deterministic, weight-free concept-basis fallback (`bragi-concept-basis-1`, NumPy only) is what
`pnpm verify` and CI exercise. Trained heads need MTG-Jamendo (CC) and are the owner's to produce.

Both gates — top-3 genre agreement and the `"drums"` stem ranking on the eval set — are **PENDING**
(no eval set, no weights, no training data). The `"drums"` ranking *metric* is proven on a synthetic
multi-stem fixture through the fallback embedder
(`analysis/tests/test_embedding.py::test_the_text_query_drums_ranks_the_drum_stem_highest`). See
[`docs/wp/1.6.md`](../../../docs/wp/1.6.md) and
[ADR-0011](../../../specs/decisions/ADR-0011-embeddings-and-tags.md).
