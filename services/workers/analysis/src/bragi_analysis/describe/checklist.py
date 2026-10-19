"""The automated eval checklist for ``describe`` (``specs/04`` §6.3 and §8).

The manual review in §8 asks whether a description is grounded, free of jargon and free of artist
names. These are the automatable parts, as **hard** findings (any one fails the track) and **soft**
findings (reported, not failing). They run on the *final* output of the pipeline, so they also check
what the post-check should already have removed. A hard finding there is a bug in the post-check.

They are proven on synthetic fixtures with canned replies. They do not decide the eval gate, which
needs the owner's eval set (Q32, Q73).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from bragi_analysis.describe import grounding
from bragi_analysis.describe.features import DescribeFeatures
from bragi_common.generated.models import DescriptionResult

#: Plain-language rule (04 §6.3 "no jargon"). A match is a hard failure.
JARGON_TERMS: tuple[str, ...] = (
    "BPM",
    "LUFS",
    "LRA",
    "dBFS",
    "dBTP",
    "dB",
    "RMS",
    "spectral",
    "centroid",
    "z-score",
    "sigmoid",
    "MIDI",
    "tonic",
    "Roman numeral",
    "Roman numerals",
    "onset",
    "onsets",
    "timbre",
    "self-similarity",
    "energy slope",
)

#: Soft limits: reported, not failing. Keep the summary short and the list brief.
SUMMARY_MAX_SENTENCES = 4
SUMMARY_MAX_WORDS = 90


@dataclass(frozen=True)
class Finding:
    """One checklist result. ``detail`` names a term or code, never a sentence."""

    severity: str  # "hard" or "soft"
    code: str
    detail: str


def check(
    result: DescriptionResult,
    features: DescribeFeatures,
    blocked_terms: tuple[str, ...] = (),
) -> list[Finding]:
    """All findings for one final description. An empty list means a clean pass."""
    findings: list[Finding] = []
    if not result.summary.strip():
        findings.append(Finding("hard", "empty_summary", "summary"))

    texts = _all_texts(result)
    for where, text in texts:
        for term in JARGON_TERMS:
            if re.search(r"(?<![A-Za-z])" + re.escape(term) + r"(?![A-Za-z])", text, re.IGNORECASE):
                findings.append(Finding("hard", "jargon", f"{where}:{term}"))
        for problem in grounding.violations(text, features, blocked_terms):
            # The post-check strips these; a survivor means the post-check has a hole.
            findings.append(Finding("hard", problem.code, f"{where}:{problem.detail}"))

    for note in result.sectionNotes:
        if int(note.index) not in features.section_indices:
            findings.append(Finding("hard", "unknown_section", f"sectionNotes:{note.index}"))

    sentences = grounding.split_sentences(result.summary)
    if len(sentences) > SUMMARY_MAX_SENTENCES:
        findings.append(Finding("soft", "summary_long_sentences", str(len(sentences))))
    if len(result.summary.split()) > SUMMARY_MAX_WORDS:
        findings.append(Finding("soft", "summary_long_words", str(len(result.summary.split()))))
    return findings


def hard_failures(findings: list[Finding]) -> list[Finding]:
    """The findings that fail a track."""
    return [finding for finding in findings if finding.severity == "hard"]


def _all_texts(result: DescriptionResult) -> list[tuple[str, str]]:
    texts: list[tuple[str, str]] = [("summary", result.summary)]
    texts.extend(("sectionNotes", note.text) for note in result.sectionNotes)
    texts.extend(("whatMakesItWorks", item) for item in result.whatMakesItWorks)
    return texts


__all__ = ["JARGON_TERMS", "Finding", "check", "hard_failures"]
