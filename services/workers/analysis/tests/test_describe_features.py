"""The §5.6 feature join for ``describe`` (WP-1.7)."""

from __future__ import annotations

from describe_support import (
    describe_features,
    harmony_result,
    loudness_result,
    rhythm_result,
    stem_result,
    structure_result,
    tag_result,
)

from bragi_analysis.describe import features as feature_builder


def test_the_section_join_carries_the_summary_record() -> None:
    joined = describe_features()

    assert joined.tempoBpm == 100.0
    assert (joined.keyTonic, joined.keyMode) == ("C", "major")
    assert joined.durationSec == 40.0
    assert joined.energyShape == "builds toward the end"
    assert (joined.energyMin, joined.energyMax) == (0.2, 1.0)

    assert [section.kind for section in joined.sections] == ["intro", "verse", "chorus"]
    intro = joined.sections[0]
    assert (intro.startSec, intro.endSec) == (0.0, 8.0)
    assert intro.repeatGroup == "A"
    assert intro.bars == 3  # 8 s at 100 BPM in 4/4
    assert (intro.meanEnergy, intro.energySlope) == (0.25, 0.02)
    assert intro.chords == "I-V"  # the repeated "I" collapses
    # presence: drums 0.7, bass 0.4, piano 0.6 pass the 0.25 gate; vocals 0.1 does not.
    assert intro.activeStems == ("bass", "drums", "piano")
    assert joined.sections[1].chords == "vi-IV"


def test_the_song_level_labels_and_stems_are_kept() -> None:
    joined = describe_features()

    assert joined.genres == ("pop",)
    assert joined.moods == ("uplifting",)
    assert joined.instruments == ("piano", "drums", "bass", "vocals")
    assert joined.descriptors == ("warm",)
    assert joined.activeStems == ("bass", "drums", "piano", "vocals")
    assert joined.section_indices == frozenset({0, 1, 2})
    assert joined.missingStages == ()


def test_missing_blobs_degrade_to_empty_lists() -> None:
    empty = feature_builder.build()

    assert empty.sections == ()
    assert empty.tempoBpm is None
    assert empty.keyTonic is None
    assert empty.genres == () and empty.instruments == ()
    assert empty.activeStems == ()
    assert empty.durationSec is None
    assert set(empty.missingStages) == {
        "structure",
        "loudness_energy",
        "harmony",
        "rhythm",
        "tag",
        "stem_activity",
    }


def test_a_partial_blob_set_only_fills_what_is_present() -> None:
    joined = feature_builder.build(tags=tag_result())

    assert joined.instruments == ("piano", "drums", "bass", "vocals")
    assert joined.sections == ()
    assert joined.tempoBpm is None
    assert "tag" not in joined.missingStages


def test_low_confidence_stages_are_listed() -> None:
    joined = feature_builder.build(
        structure=structure_result(low_confidence=True),
        harmony=harmony_result(),
        tags=tag_result(low_confidence=True),
        rhythm=rhythm_result(),
        stems=stem_result(),
        loudness=loudness_result(),
    )

    assert set(joined.lowConfidenceStages) == {"structure", "tag"}


def test_stems_can_ground_the_active_set_without_a_tag_blob() -> None:
    joined = feature_builder.build(stems=stem_result())

    assert joined.activeStems == ("bass", "drums", "piano", "vocals")
    assert "stem_activity" not in joined.missingStages
    assert "tag" in joined.missingStages
