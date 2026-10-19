"""The grounding post-check for ``describe`` (``specs/04`` §6.3, WP-1.7 acceptance 2).

The model's text may only claim what the analysis supports. This module checks the sentences,
list items and section notes of a ``DescriptionResult`` against the features and **removes** what
it cannot ground:

- **instruments**: a word naming an instrument whose family is absent from the song's tag
  instruments and active stems is dropped (for example "a sitar carries the hook" when there is no
  sitar tag and no stem that could hold one);
- **key**: "in F# minor" must match the harmony key;
- **tempo**: "120 beats per minute" must match the rhythm tempo within 3 % (or 3 BPM);
- **blocked terms**: any term from the blocklist (artist names, ``specs/10`` §7) drops the sentence;
- **section indices**: a section note must refer to a section that exists.

The summary is rejected outright (``GroundingRejectedError``) when no sentence survives, because an
ungrounded summary is not something to show. The report lists what was removed, by code and family
or term only; the sentence text is carried for tests and the eval report and is never logged
(``specs/13`` §3).

The instrument vocabulary below is a fixed synonym table. It covers the taxonomy instrument names
(``packages/schemas/analysis/taxonomy.json``) and the stem roles; an instrument family is supported
when a tag label or an active stem names it. Anything outside the table cannot be checked, which is
why the system prompt states the instrument rule directly too.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from bragi_analysis.describe.features import DescribeFeatures
from bragi_common.generated.models import DescriptionResult, SectionNote

#: Instrument families and the words that name them, in normalised (lower-case, spaces) text.
#: A family is supported by a tag instrument label or an active stem (``STEM_FAMILY``).
FAMILY_TERMS: dict[str, tuple[str, ...]] = {
    "drums": (
        "drum",
        "drums",
        "drum kit",
        "drum machine",
        "kick",
        "kick drum",
        "snare",
        "snare drum",
        "hi hat",
        "hi hats",
        "hihat",
        "hihats",
        "hat",
        "hats",
        "cymbal",
        "cymbals",
        "tom",
        "toms",
        "808",
        "909",
        "percussion",
        "congas",
        "bongos",
        "djembe",
        "tablas",
        "shaker",
        "tambourine",
        "hand claps",
        "hand clap",
        "finger snaps",
        "finger snap",
        "brushes",
        "timpani",
        "ride",
        "crash",
    ),
    "bass": (
        "bass",
        "bassline",
        "bass line",
        "double bass",
        "electric bass",
        "synth bass",
        "sub bass",
        "upright bass",
    ),
    "vocals": (
        "vocal",
        "vocals",
        "voice",
        "voices",
        "singer",
        "singing",
        "choir",
        "backing vocals",
        "vocal chops",
        "male vocals",
        "female vocals",
        "lead vocal",
        "harmonies",
    ),
    "guitar": (
        "guitar",
        "guitars",
        "acoustic guitar",
        "electric guitar",
        "distorted guitar",
        "clean guitar",
        "guitar solo",
        "rhythm guitar",
        "lead guitar",
    ),
    "keys": (
        "piano",
        "pianos",
        "grand piano",
        "electric piano",
        "keys",
        "keyboard",
        "keyboards",
        "rhodes",
        "wurlitzer",
        "organ",
        "hammond organ",
        "harpsichord",
        "celesta",
        "clavinet",
    ),
    "synth": (
        "synth",
        "synths",
        "synthesizer",
        "synthesizers",
        "analog synth",
        "modular synth",
        "lead synth",
        "pad",
        "pads",
        "arpeggiator",
        "arpeggio",
        "pluck",
        "plucks",
        "vocoder",
        "talkbox",
    ),
    "strings": (
        "strings",
        "string section",
        "string ensemble",
        "orchestral strings",
        "violin",
        "violins",
        "viola",
        "violas",
        "cello",
        "cellos",
        "pizzicato",
    ),
    "brass": (
        "brass",
        "horn",
        "horns",
        "trumpet",
        "trumpets",
        "trombone",
        "trombones",
        "french horn",
        "tuba",
        "saxophone",
        "saxophones",
        "sax",
    ),
    "woodwind": (
        "flute",
        "flutes",
        "clarinet",
        "clarinets",
        "oboe",
        "bassoon",
        "recorder",
        "pan flute",
    ),
    "bells": (
        "bell",
        "bells",
        "glockenspiel",
        "xylophone",
        "marimba",
        "vibraphone",
        "steel drum",
        "tubular bells",
    ),
    "harp": ("harp",),
    "banjo": ("banjo",),
    "mandolin": ("mandolin",),
    "ukulele": ("ukulele",),
    "sitar": ("sitar",),
    "koto": ("koto",),
    "erhu": ("erhu",),
    "didgeridoo": ("didgeridoo",),
    "accordion": ("accordion",),
    "harmonica": ("harmonica",),
    "whistle": ("whistle",),
}

#: The stem role that supports each family. Stems without a family (``other``, ``residual``,
#: ``full_mix``) support none.
STEM_FAMILY: dict[str, str] = {
    "drums": "drums",
    "bass": "bass",
    "vocals": "vocals",
    "guitar": "guitar",
    "piano": "keys",
    "synth": "synth",
    "strings": "strings",
}

# "in F# minor" / "key of Bb major". The tonic letter is upper-case only, so "in a minor way" never
# reads as a key claim.
_KEY_CLAIM = re.compile(
    r"(?:[Ii]n|[Kk]ey of)(?: the key of)?\s+([A-G])([#b♯♭]?)\s+([Mm]ajor|[Mm]inor)\b"
)
_TEMPO_CLAIM = re.compile(
    r"\b(\d{2,3}(?:\.\d+)?)\s*(?:bpm|beats per minute|beats a minute)\b", re.IGNORECASE
)
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")

_ENHARMONIC = {
    "Db": "C#",
    "Eb": "D#",
    "Gb": "F#",
    "Ab": "G#",
    "Bb": "A#",
    "Cb": "B",
    "Fb": "E",
    "E#": "F",
    "B#": "C",
}


def _normalise(text: str) -> str:
    """Lower-cases and turns ``-``/``_`` into spaces, so taxonomy ids match the word table."""
    return text.replace("-", " ").replace("_", " ").lower()


_FAMILY_PATTERNS: dict[str, re.Pattern[str]] = {
    family: re.compile(
        r"\b(?:"
        + "|".join(re.escape(term) for term in sorted(terms, key=len, reverse=True))
        + r")\b"
    )
    for family, terms in FAMILY_TERMS.items()
}


class GroundingRejectedError(Exception):
    """The summary has no grounded sentence left, so the whole description is refused."""


@dataclass(frozen=True)
class Violation:
    """One unsupported claim. ``detail`` is a family or term name, never the sentence."""

    code: str
    detail: str


@dataclass(frozen=True)
class Removal:
    """One thing the post-check removed. ``text`` is for tests and the eval report only."""

    where: str
    violation: Violation
    text: str


@dataclass(frozen=True)
class GroundingReport:
    """The description with unsupported claims removed, and what was removed."""

    result: DescriptionResult
    removals: tuple[Removal, ...]


def supported_families(features: DescribeFeatures) -> frozenset[str]:
    """Instrument families the analysis supports: tag instrument labels plus active stems."""
    families: set[str] = set()
    for label in features.instruments:
        families |= _families_in(label)
    for role in features.activeStems:
        family = STEM_FAMILY.get(role)
        if family is not None:
            families.add(family)
    return frozenset(families)


def _families_in(text: str) -> set[str]:
    normalised = _normalise(text)
    return {family for family, pattern in _FAMILY_PATTERNS.items() if pattern.search(normalised)}


def normalise_tonic(tonic: str) -> str:
    """``"Bb"`` -> ``"A#"``, ``"f#"`` -> ``"F#"``, so enharmonic spellings compare equal."""
    if not tonic:
        return tonic
    name = tonic[0].upper() + tonic[1:]
    return _ENHARMONIC.get(name, name)


def violations(
    text: str, features: DescribeFeatures, blocked_terms: Iterable[str] = ()
) -> list[Violation]:
    """Every unsupported claim in ``text`` (one sentence or item), in a stable order."""
    found: list[Violation] = []
    supported = supported_families(features)
    for family in sorted(_families_in(text) - supported):
        found.append(Violation("unsupported_instrument", family))
    for match in _KEY_CLAIM.finditer(text):
        tonic = normalise_tonic(match.group(1) + match.group(2).replace("♯", "#").replace("♭", "b"))
        mode = match.group(3).lower()
        if features.keyTonic is None or features.keyMode is None:
            found.append(Violation("unsupported_key", "no key in the analysis"))
        elif tonic != normalise_tonic(features.keyTonic) or mode != features.keyMode:
            found.append(Violation("unsupported_key", f"{tonic} {mode}"))
    for match in _TEMPO_CLAIM.finditer(text):
        claimed = float(match.group(1))
        if features.tempoBpm is None:
            found.append(Violation("unsupported_tempo", "no tempo in the analysis"))
        elif abs(claimed - features.tempoBpm) > max(3.0, 0.03 * features.tempoBpm):
            found.append(Violation("unsupported_tempo", f"{claimed:g}"))
    lowered = text.lower()
    for term in blocked_terms:
        if term and re.search(r"\b" + re.escape(term.lower()) + r"\b", lowered):
            found.append(Violation("blocked_term", term))
    return found


def split_sentences(text: str) -> list[str]:
    """Sentences of ``text``, whitespace-trimmed, empty pieces dropped."""
    return [part.strip() for part in _SENTENCE_END.split(text.strip()) if part.strip()]


def ground(
    description: DescriptionResult,
    features: DescribeFeatures,
    blocked_terms: Iterable[str] = (),
) -> GroundingReport:
    """Removes every ungrounded sentence, item and note; rejects an empty summary.

    Raises:
        GroundingRejectedError: when no summary sentence is grounded.
    """
    blocked = tuple(blocked_terms)
    removals: list[Removal] = []

    kept_sentences: list[str] = []
    for sentence in split_sentences(description.summary):
        problems = violations(sentence, features, blocked)
        if problems:
            removals.extend(Removal("summary", problem, sentence) for problem in problems)
        else:
            kept_sentences.append(sentence)
    if not kept_sentences:
        raise GroundingRejectedError("no summary sentence is grounded in the analysis")
    summary = " ".join(kept_sentences)

    notes: list[SectionNote] = []
    for note in description.sectionNotes:
        if int(note.index) not in features.section_indices:
            removals.append(
                Removal("sectionNotes", Violation("unknown_section", str(note.index)), note.text)
            )
            continue
        problems = violations(note.text, features, blocked)
        if problems:
            removals.extend(Removal("sectionNotes", problem, note.text) for problem in problems)
            continue
        notes.append(note)

    points: list[str] = []
    for item in description.whatMakesItWorks:
        problems = [
            p for sentence in split_sentences(item) for p in violations(sentence, features, blocked)
        ]
        if problems:
            removals.extend(Removal("whatMakesItWorks", problem, item) for problem in problems)
            continue
        points.append(item)

    if description.suggestedTitle is not None:
        # 04 §6.3: a suggested title is for generated songs only. Analysis of an upload never has
        # one, so a title the model volunteers is not part of the analysis.
        removals.append(
            Removal(
                "suggestedTitle",
                Violation("not_applicable", "analysed upload"),
                description.suggestedTitle,
            )
        )

    result = description.model_copy(
        update={
            "summary": summary,
            "sectionNotes": notes,
            "whatMakesItWorks": points,
            "suggestedTitle": None,
        }
    )
    return GroundingReport(result=result, removals=tuple(removals))


__all__ = [
    "FAMILY_TERMS",
    "STEM_FAMILY",
    "GroundingRejectedError",
    "GroundingReport",
    "Removal",
    "Violation",
    "ground",
    "normalise_tonic",
    "split_sentences",
    "supported_families",
    "violations",
]
