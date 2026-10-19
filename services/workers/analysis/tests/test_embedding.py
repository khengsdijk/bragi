"""Embedding core: windowing, pooling, the concept basis, the CLAP seam and the store."""

from __future__ import annotations

import asyncio
from pathlib import Path

import numpy as np
import pytest
from embedding_support import FakePool, synthetic_stems

from bragi_analysis.embedding import pipeline, store, windows
from bragi_analysis.embedding.clap import CLAPEmbedder
from bragi_analysis.embedding.fallback import FallbackEmbedder
from bragi_analysis.embedding.protocol import EmbedderUnavailableError, select

SAMPLE_RATE = 22_050


def test_window_grid_is_10s_with_a_5s_hop_and_a_clamped_tail() -> None:
    assert windows.window_spans(8.0) == [(0.0, 8.0)]
    assert windows.window_spans(10.0) == [(0.0, 10.0)]
    assert windows.window_spans(12.0) == [(0.0, 10.0), (5.0, 12.0)]
    assert windows.window_spans(25.0) == [(0.0, 10.0), (5.0, 15.0), (10.0, 20.0), (15.0, 25.0)]
    assert windows.window_spans(0.0) == []


def test_coverage_weights_windows_by_overlap() -> None:
    assert windows.coverage((0.0, 10.0), []) == 1.0
    assert windows.coverage((0.0, 10.0), [(0.0, 5.0)]) == 0.5
    assert windows.coverage((5.0, 15.0), [(0.0, 10.0)]) == 0.5
    assert windows.coverage((0.0, 10.0), [(20.0, 30.0)]) == 0.0


def test_pool_is_the_weighted_mean_and_l2_normalised() -> None:
    a = np.asarray([1.0, 0.0])
    b = np.asarray([0.0, 1.0])
    pooled, low = windows.pool([a, b], [1.0, 3.0], dim=2)
    assert not low
    assert pooled == pytest.approx([0.31622777, 0.94868330], abs=1e-6)
    assert float(np.linalg.norm(pooled)) == pytest.approx(1.0)
    silent, low = windows.pool([np.zeros(2), np.zeros(2)], None, dim=2)
    assert low and float(np.linalg.norm(silent)) == pytest.approx(1.0)


def test_the_embedder_is_deterministic_and_l2_normalised() -> None:
    embedder = FallbackEmbedder()
    mono = synthetic_stems(SAMPLE_RATE, 6.0)["drums"]
    first = embedder.window_vectors(mono, SAMPLE_RATE)
    second = embedder.window_vectors(mono, SAMPLE_RATE)
    assert len(first) == 1
    assert np.array_equal(first[0], second[0])
    assert float(np.linalg.norm(first[0])) == pytest.approx(1.0)
    assert embedder.dim == windows.DIM


def test_text_embedding_is_l2_normalised_and_zero_without_a_concept() -> None:
    embedder = FallbackEmbedder()
    rows = embedder.embed_texts(["drums", "zzzznomatch"])
    assert rows.shape == (2, windows.DIM)
    assert float(np.linalg.norm(rows[0])) == pytest.approx(1.0)
    assert float(np.linalg.norm(rows[1])) == pytest.approx(0.0)


def test_the_text_query_drums_ranks_the_drum_stem_highest() -> None:
    """Acceptance 2's *metric*, proven on a synthetic quartet via the fallback embedder."""
    embedder = FallbackEmbedder()
    stems = synthetic_stems(SAMPLE_RATE, 8.0)
    vectors = {
        role: pipeline.pooled_vector(embedder, mono, SAMPLE_RATE, None)[0]
        for role, mono in stems.items()
    }
    query = embedder.embed_texts(["drums"])[0]
    cosine = {role: float(query @ vector) for role, vector in vectors.items()}
    ranked = sorted(cosine, key=lambda role: -cosine[role])
    assert ranked[0] == "drums"
    assert cosine["drums"] > 2 * max(cosine[role] for role in ranked[1:])

    # The query is specific: "bass" ranks the bass stem, not the drums.
    bass_query = embedder.embed_texts(["bass"])[0]
    bass_cosine = {role: float(bass_query @ vector) for role, vector in vectors.items()}
    assert max(bass_cosine, key=lambda role: bass_cosine[role]) == "bass"


def test_select_auto_falls_back_and_clap_requires_weights(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BRAGI_CLAP_CHECKPOINT", raising=False)
    monkeypatch.delenv("BRAGI_MODELS_DIR", raising=False)
    assert isinstance(select("auto"), FallbackEmbedder)
    assert isinstance(select("fallback"), FallbackEmbedder)
    assert not CLAPEmbedder.available()
    with pytest.raises(EmbedderUnavailableError, match="checkpoint"):
        select("clap")
    with pytest.raises(ValueError, match="unknown embedder"):
        select("nope")


def test_clap_loader_refuses_missing_and_unpinned_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BRAGI_CLAP_CHECKPOINT", str(tmp_path))
    assert CLAPEmbedder.available()  # the directory exists, so it is a candidate...
    with pytest.raises(EmbedderUnavailableError, match=r"model\.safetensors"):
        CLAPEmbedder.load()  # ...but the weights file is missing

    (tmp_path / "model.safetensors").write_bytes(b"not really weights")
    monkeypatch.delenv("BRAGI_CLAP_SHA256", raising=False)
    with pytest.raises(EmbedderUnavailableError, match="SHA-256 is not pinned"):
        CLAPEmbedder.load()

    monkeypatch.setenv("BRAGI_CLAP_SHA256", "0" * 64)
    with pytest.raises(EmbedderUnavailableError, match="does not match the pinned SHA-256"):
        CLAPEmbedder.load()


def test_store_row_ids_are_deterministic_and_vectors_are_pgvector_literals() -> None:
    first = store.row_id("sha256:abc", "stem", "drums", "bragi-concept-basis-1")
    second = store.row_id("sha256:abc", "stem", "drums", "bragi-concept-basis-1")
    other = store.row_id("sha256:abc", "stem", "bass", "bragi-concept-basis-1")
    assert first == second and first != other
    assert store._vector_literal([0.5, -1.0]) == "[0.5,-1]"


def test_pgvector_store_writes_through_one_executemany() -> None:
    pool = FakePool()
    pg = store.PgVectorStore(pool)
    row = store.EmbeddingRow(
        id="emb_x", asset_hash="sha256:a", scope="song", scope_ref=None, model="m", vector=[0.25]
    )
    assert asyncio.run(pg.upsert([row])) == 1
    sql, params = pool.calls[0]
    assert "::vector" in sql and params == [("emb_x", "sha256:a", "song", None, "m", "[0.25]")]
    assert asyncio.run(pg.upsert([])) == 0
    asyncio.run(pg.close())
    assert pool.closed


def test_the_packaged_taxonomy_matches_the_schema_source() -> None:
    from bragi_analysis.tagging import taxonomy

    source = (
        Path(__file__).resolve().parents[4] / "packages" / "schemas" / "analysis" / "taxonomy.json"
    )
    assert source.is_file(), f"{source} is missing (run from a checkout)"
    packaged = (
        Path(__file__).resolve().parents[1] / "src" / "bragi_analysis" / "config" / "taxonomy.json"
    )
    assert packaged.read_bytes() == source.read_bytes()
    assert taxonomy.default().version == 1
