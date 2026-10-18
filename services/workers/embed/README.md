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

**Status:** scaffold. Built by **WP-1.6**, then **WP-3.2**.
