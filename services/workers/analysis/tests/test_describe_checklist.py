"""The automated 04 §6.3/§8 checklist over synthetic fixtures and canned replies (WP-1.7).

The "0 hard failures" result below is **synthetic**: it proves the checklist machinery and the
post-check, not the quality of real model output on the owner's eval set (Q32, Q73).
"""

from __future__ import annotations

import asyncio

from describe_support import (
    GOOD_REPLY,
    FakeDescribeClient,
    harmony_result,
    loudness_result,
    rhythm_result,
    structure_result,
)

from bragi_analysis.describe import checklist, pipeline
from bragi_analysis.describe import features as feature_builder
from bragi_common.generated.models import (
    DescriptionResult,
    DescriptionResultSchemaVersion,
    SecRange,
    SectionNote,
    SectionPresence,
    StemActivity,
    StemActivityResult,
    StemActivityResultSchemaVersion,
    StemRole,
    TagResult,
    TagResultSchemaVersion,
    TagScore,
)

ELECTRONIC_REPLY = (
    '{"summary": "A tight electronic track built on a warm analog synth and a driving drum '
    'machine. The bass holds the low end while the arrangement grows.", '
    '"sectionNotes": [{"index": 2, "text": "The chorus adds a bright lead synth."}], '
    '"whatMakesItWorks": ["The drums and bass stay steady as the synths widen."]}'
)

ACOUSTIC_REPLY = (
    '{"summary": "An intimate acoustic guitar and strings carry the song. The vocal stays close '
    'and the arrangement builds gently.", '
    '"sectionNotes": [{"index": 0, "text": "The intro is just the guitar."}], '
    '"whatMakesItWorks": ["The strings enter to lift the final section."]}'
)


def _features(
    instruments: list[str], stem_roles: list[StemRole]
) -> feature_builder.DescribeFeatures:
    tags = TagResult(
        schemaVersion=TagResultSchemaVersion.integer_1,
        genres=[TagScore(label="pop", score=0.8)],
        moods=[TagScore(label="calm", score=0.6)],
        instruments=[TagScore(label=label, score=0.8) for label in instruments],
        descriptors=[],
    )
    stems = StemActivityResult(
        schemaVersion=StemActivityResultSchemaVersion.integer_1,
        stems=[
            StemActivity(
                role=role,
                active=[SecRange(startSec=0.0, endSec=40.0)],
                presence=[SectionPresence(index=index, presence=0.8) for index in range(3)],
            )
            for role in stem_roles
        ],
    )
    return feature_builder.build(
        structure=structure_result(),
        loudness=loudness_result(),
        harmony=harmony_result(),
        rhythm=rhythm_result(),
        tags=tags,
        stems=stems,
    )


def _fixtures() -> list[tuple[feature_builder.DescribeFeatures, str]]:
    """Three synthetic analysis fixtures, each with a good canned reply."""
    return [
        (
            _features(["piano", "drums", "bass", "vocals"], [StemRole.drums, StemRole.bass]),
            GOOD_REPLY,
        ),
        (
            _features(
                ["analog-synth", "drum-machine", "synth-bass"], [StemRole.synth, StemRole.drums]
            ),
            ELECTRONIC_REPLY,
        ),
        (
            _features(
                ["acoustic-guitar", "strings", "vocals"], [StemRole.guitar, StemRole.strings]
            ),
            ACOUSTIC_REPLY,
        ),
    ]


def test_three_synthetic_fixtures_produce_no_hard_failures() -> None:
    for features, reply in _fixtures():
        outcome = asyncio.run(
            pipeline.describe(features, FakeDescribeClient([reply]), model="fake", max_tokens=512)
        )
        findings = checklist.check(outcome.result, features)

        assert checklist.hard_failures(findings) == [], (features, findings)


def _description(
    summary: str,
    *,
    section_notes: list[SectionNote] | None = None,
) -> DescriptionResult:
    return DescriptionResult(
        schemaVersion=DescriptionResultSchemaVersion.integer_1,
        summary=summary,
        sectionNotes=section_notes or [],
        whatMakesItWorks=[],
    )


def test_jargon_is_a_hard_failure() -> None:
    features, _ = _fixtures()[0]
    findings = checklist.check(_description("The mix is limited to -9 LUFS."), features)

    assert [(f.severity, f.code) for f in checklist.hard_failures(findings)] == [("hard", "jargon")]


def test_an_unsupported_instrument_is_a_hard_failure() -> None:
    features, _ = _fixtures()[0]
    findings = checklist.check(_description("A sitar carries the hook."), features)

    assert [f.code for f in checklist.hard_failures(findings)] == ["unsupported_instrument"]


def test_an_artist_name_is_a_hard_failure() -> None:
    features, _ = _fixtures()[0]
    findings = checklist.check(
        _description("It sounds like Nirvana."), features, blocked_terms=("Nirvana",)
    )

    assert "blocked_term" in {finding.code for finding in checklist.hard_failures(findings)}


def test_an_unknown_section_index_is_a_hard_failure() -> None:
    features, _ = _fixtures()[0]
    findings = checklist.check(
        _description("A warm song.", section_notes=[SectionNote(index=9, text="The outro.")]),
        features,
    )

    assert [f.code for f in checklist.hard_failures(findings)] == ["unknown_section"]


def test_an_empty_summary_is_a_hard_failure() -> None:
    features, _ = _fixtures()[0]
    # ``model_construct`` bypasses the schema's minLength so the checklist's own guard is tested.
    empty = DescriptionResult.model_construct(
        schemaVersion=DescriptionResultSchemaVersion.integer_1,
        summary="",
        sectionNotes=[],
        whatMakesItWorks=[],
        suggestedTitle=None,
    )

    assert [f.code for f in checklist.hard_failures(checklist.check(empty, features))] == [
        "empty_summary"
    ]


def test_a_long_summary_is_only_a_soft_finding() -> None:
    features, _ = _fixtures()[0]
    long_summary = " ".join(
        [
            "The piano opens the song.",
            "The drums enter quietly.",
            "The bass locks in.",
            "The vocal arrives.",
            "The arrangement grows.",
        ]
    )

    findings = checklist.check(_description(long_summary), features)

    assert checklist.hard_failures(findings) == []
    assert [f.code for f in findings if f.severity == "soft"] == ["summary_long_sentences"]
