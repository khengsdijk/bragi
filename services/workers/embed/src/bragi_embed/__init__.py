"""Embedding and projection workers: the machinery behind the Universe.

Capabilities: CLAP audio and text embeddings at song, section and stem scope,
the trained tag heads, pgvector storage, the library map projection and
constellation edges (``specs/04-analysis-pipeline.md`` §5.4, §6,
``specs/08-universe.md``).

Status:
    Scaffold (WP-0.1). Embeddings and tags arrive with **WP-1.6**; projection,
    clustering and naming with **WP-3.2**.
"""
