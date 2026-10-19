"""The grounding post-check for ``describe`` (04 §6.3; WP-1.7 acceptance 2).

The acceptance criterion is the hallucinated-instrument test below: a claim that names an
instrument absent from the tags and active stems is removed, and a description whose summary is
left with nothing grounded is refused.
"""

from __future__ import annotations

import pytest
from describe_support import describe_features, pop_blobs

from bragi_analysis.describe import grounding
from bragi_analysis.describe.features import DescribeFeatures
from bragi_common.generated.models import (
    DescriptionResult,
    DescriptionResultSchemaVersion,
    SectionNote,
)


def _description(
    summary: str,
    *,
    section_notes: list[SectionNote] | None = None,
    points: list[str] | None = None,
) -> DescriptionResult:
    return DescriptionResult(
        schemaVersion=DescriptionResultSchemaVersion.integer_1,
        summary=summary,
        sectionNotes=section_notes or [],
        whatMakesItWorks=points or [],
    )


@pytest.fixture
def features() -> DescribeFeatures:
    return describe_features()


def test_supported_families_come_from_tags_and_stems(features: DescribeFeatures) -> None:
    assert grounding.supported_families(features) == {"bass", "drums", "keys", "vocals"}


def test_a_hallucinated_instrument_is_a_violation(features: DescribeFeatures) -> None:
    violations = grounding.violations("A sitar carries the hook.", features)

    assert [(v.code, v.detail) for v in violations] == [("unsupported_instrument", "sitar")]


def test_a_supported_instrument_is_grounded(features: DescribeFeatures) -> None:
    assert grounding.violations("A Rhodes piano carries the hook.", features) == []


def test_the_post_check_strips_the_hallucinated_sentence_and_keeps_the_rest(
    features: DescribeFeatures,
) -> None:
    description = _description(
        "The piano sets a warm mood. A sitar carries the hook.",
        points=["The drums drop out before the chorus."],
    )

    report = grounding.ground(description, features)

    assert report.result.summary == "The piano sets a warm mood."
    assert [removal.violation.code for removal in report.removals] == ["unsupported_instrument"]
    assert report.removals[0].text == "A sitar carries the hook."
    assert report.result.whatMakesItWorks == ["The drums drop out before the chorus."]


def test_a_summary_of_only_hallucinations_is_rejected(features: DescribeFeatures) -> None:
    description = _description("A sitar carries the hook. An erhu answers it.")

    with pytest.raises(grounding.GroundingRejectedError):
        grounding.ground(description, features)


def test_an_unsupported_section_index_is_dropped(features: DescribeFeatures) -> None:
    description = _description(
        "The piano sets a warm mood.",
        section_notes=[
            SectionNote(index=0, text="The intro is quiet."),
            SectionNote(index=9, text="The outro dissolves."),
        ],
    )

    report = grounding.ground(description, features)

    assert [note.index for note in report.result.sectionNotes] == [0]
    assert report.removals[-1].violation.code == "unknown_section"


def test_a_contradicting_key_or_tempo_is_stripped(features: DescribeFeatures) -> None:
    assert grounding.violations("It sits in C major.", features) == []
    assert grounding.violations("It sits in F# minor.", features)[0].code == "unsupported_key"
    assert grounding.violations("The tempo is 100 beats per minute.", features) == []
    assert (
        grounding.violations("The tempo is 128 beats per minute.", features)[0].code
        == "unsupported_tempo"
    )


def test_a_key_or_tempo_claim_with_no_analysis_is_unsupported() -> None:
    empty = DescribeFeatures()

    assert grounding.violations("It sits in C major.", empty)[0].code == "unsupported_key"
    assert grounding.violations("It is 120 beats per minute.", empty)[0].code == "unsupported_tempo"


def test_a_blocked_artist_term_drops_the_sentence(features: DescribeFeatures) -> None:
    violations = grounding.violations("It sounds like Nirvana.", features, ("Nirvana",))

    assert [(v.code, v.detail) for v in violations] == [("blocked_term", "Nirvana")]


def test_an_unmentioned_instrument_family_is_not_invented() -> None:
    # Only a tag label supports an instrument family; an unrelated stem never does.
    only_drums = grounding.supported_families(
        DescribeFeatures(instruments=("hi-hat",), activeStems=("other",))
    )
    assert only_drums == {"drums"}


def test_pop_blobs_do_not_ground_a_sitar() -> None:
    features = describe_features()
    assert "sitar" not in pop_blobs()["tag"].model_dump_json()
    assert grounding.violations("A sitar carries the hook.", features)
