"""The taxonomy, zero-shot scoring, MLP heads and ``TagResult`` assembly (04 §6.2)."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pytest

from bragi_analysis.embedding import pipeline
from bragi_analysis.embedding.fallback import FallbackEmbedder
from bragi_analysis.tagging import pipeline as tagging
from bragi_analysis.tagging import taxonomy, zeroshot
from bragi_common.generated.models import TagResult

SAMPLE_RATE = 22_050
#: The source-of-truth taxonomy file (the packaged copy is asserted equal in test_embedding.py).
TAXONOMY_SOURCE = (
    Path(__file__).resolve().parents[4] / "packages" / "schemas" / "analysis" / "taxonomy.json"
)


def test_the_shipped_taxonomy_is_valid_and_meets_the_spec_targets() -> None:
    vocab = taxonomy.default()
    assert vocab.version == 1
    for category, minimum in taxonomy.MINIMUMS.items():
        assert len(vocab.entries(category)) >= minimum, category
    # ids are unique within every category
    for category in taxonomy.CATEGORIES:
        ids = [entry.id for entry in vocab.entries(category)]
        assert len(ids) == len(set(ids)), category
    # every genre parent exists and every entry has a prompt
    genre_ids = {entry.id for entry in vocab.genres}
    for entry in vocab.genres:
        assert set(entry.parents) <= genre_ids, entry.id
    assert all(
        entry.prompt for category in taxonomy.CATEGORIES for entry in vocab.entries(category)
    )
    # the hierarchy really nests (electronic > house > deep-house)
    deep_house = next(entry for entry in vocab.genres if entry.id == "deep-house")
    assert deep_house.parents == ("electronic", "house")


def test_validate_rejects_malformed_taxonomies() -> None:
    raw = json.loads(TAXONOMY_SOURCE.read_text("utf-8"))

    cyclic = json.loads(json.dumps(raw))
    for entry in cyclic["genres"]:
        if entry["id"] == "electronic":
            entry["parents"] = ["house"]
        if entry["id"] == "house":
            entry["parents"] = ["electronic"]
    with pytest.raises(taxonomy.TaxonomyError, match="cycle"):
        taxonomy.validate(cyclic)

    duplicate = json.loads(json.dumps(raw))
    duplicate["moods"].append(dict(duplicate["moods"][0]))
    with pytest.raises(taxonomy.TaxonomyError, match="duplicate id"):
        taxonomy.validate(duplicate)

    unknown_parent = json.loads(json.dumps(raw))
    unknown_parent["genres"][1]["parents"] = ["does-not-exist"]
    with pytest.raises(taxonomy.TaxonomyError, match="unknown parent"):
        taxonomy.validate(unknown_parent)

    tiny = json.loads(json.dumps(raw))
    tiny["genres"] = tiny["genres"][:2]
    with pytest.raises(taxonomy.TaxonomyError, match="below the"):
        taxonomy.validate(tiny)

    bad_id = json.loads(json.dumps(raw))
    bad_id["eras"][0]["id"] = "Bad Id"
    with pytest.raises(taxonomy.TaxonomyError, match="bad id"):
        taxonomy.validate(bad_id)


def test_prompt_defaults_are_derived_when_absent() -> None:
    raw = json.loads(TAXONOMY_SOURCE.read_text("utf-8"))
    # strip a genre's prompt to check the default
    child = next(e for e in raw["genres"] if e["id"] == "house")
    child.pop("prompt", None)
    vocab = taxonomy.validate(raw)
    house = next(e for e in vocab.genres if e.id == "house")
    assert house.prompt == "a house song"


def test_top_k_limits_match_the_spec() -> None:
    limits = tagging.limits()
    assert limits.for_category("genres") == 3
    assert limits.for_category("moods") == 4
    assert limits.for_category("descriptors") == 6
    assert limits.min_score == 0.0


def test_cosine_scores_handles_zero_vectors() -> None:
    audio = np.asarray([1.0, 0.0])
    texts = np.asarray([[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]])
    scores = zeroshot.cosine_scores(audio, texts)
    assert scores[0] == pytest.approx(1.0)
    assert scores[1] == pytest.approx(0.0)
    assert scores[2] == pytest.approx(0.0)  # a label with no concept match scores 0


def test_build_result_with_the_fallback_is_flagged_low_confidence() -> None:
    embedder = FallbackEmbedder()
    from embedding_support import synthetic_stems

    drums = synthetic_stems(SAMPLE_RATE, 8.0)["drums"]
    audio, _ = pipeline.pooled_vector(embedder, drums, SAMPLE_RATE, None)
    result = tagging.build_result(audio, taxonomy.default(), embedder, {})

    assert isinstance(result, TagResult)
    assert result.lowConfidence is True  # no trained heads
    assert any(entry.label == "drums" for entry in result.instruments)
    assert len(result.genres) <= 3 and len(result.moods) <= 4 and len(result.descriptors) <= 6
    assert len(result.instruments) <= 8
    assert result.era is None  # the fallback defines no era concepts


class _PromptEmbedder:
    """An embedder whose text vector for one prompt equals a chosen audio vector."""

    def __init__(self, audio: np.ndarray, label_id: str) -> None:
        self._audio = audio
        self._label_id = label_id
        self._fallback = FallbackEmbedder()

    @property
    def model(self) -> str:
        return "mock"

    @property
    def dim(self) -> int:
        return self._fallback.dim

    def window_vectors(self, mono: np.ndarray, sample_rate: int) -> list[np.ndarray]:
        return [self._audio]

    def embed_texts(self, texts: Sequence[str]) -> np.ndarray:
        rows = np.zeros((len(texts), self.dim), dtype=np.float64)
        for index, text in enumerate(texts):
            if self._label_id in text:
                rows[index] = self._audio
        return rows


def test_zero_shot_with_a_mock_embedder_selects_the_injected_label() -> None:
    audio = np.zeros(512)
    audio[0] = 1.0
    embedder = _PromptEmbedder(audio, "drums")
    result = tagging.build_result(audio, taxonomy.default(), embedder, {})
    assert result.instruments[0].label == "drums"
    assert result.instruments[0].score == pytest.approx(1.0)


def test_heads_are_loaded_and_used_when_present(tmp_path: Path) -> None:
    vocab = taxonomy.default()
    labels = ["drums", "bass"]
    np.savez(
        tmp_path / "instruments.npz",
        labels=np.asarray(labels),
        w1=np.zeros((2, 512), dtype=np.float32),
        b1=np.zeros(2, dtype=np.float32),
        w2=np.eye(2, dtype=np.float32),
        b2=np.zeros(2, dtype=np.float32),
    )
    heads = zeroshot.load_heads(tmp_path)
    assert set(heads) == {"instruments"}
    head = heads["instruments"]
    vector = np.zeros(512)
    vector[0] = 1.0
    scores = zeroshot.classify(head, vector)
    assert float(scores.sum()) == pytest.approx(1.0)

    # build_result with heads scores from the head, not zero-shot, and is not flagged
    embedder = FallbackEmbedder()
    audio = np.zeros(512)
    audio[1] = 1.0  # the head weights are zero, so the softmax is uniform; both labels score 0.5
    result = tagging.build_result(audio, vocab, embedder, heads)
    assert result.lowConfidence is None
    assert {entry.label for entry in result.instruments} <= set(labels)
    assert len(result.genres) <= 3  # genres has no head, so zero-shot still fills it


def test_load_heads_is_empty_without_a_directory() -> None:
    assert zeroshot.load_heads(None) == {}
    assert zeroshot.load_heads(Path("/does/not/exist")) == {}
