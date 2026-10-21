"""Result-blob conversion shared by the generation capabilities (09 §6, §8).

Every capability uploads the same pair: the processed candidate as 24-bit FLAC and
a JSON blob with the keys, the ``match_eq`` and the seven gate verdicts. Only the
blob's schema differs (``GenerateExtendResult`` has one seam, ``GenerateFillResult``
two), so the field conversions and the upload live here.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Callable, Mapping, Sequence

from pydantic import BaseModel

from bragi_common.context import JobContext
from bragi_common.generated.models import (
    ExtendKeyMatch,
    ExtendKeyRelation,
    ExtendMatchEq,
    ExtendStep,
    KeyMode,
    MusicalKey,
)
from bragi_generate.audio import encode_flac
from bragi_generate.postprocess import Audio, FillGateResult, GateResult, KeyMatch, MatchEq
from bragi_generate.postprocess.types import NOTE_NAMES

type AnyGate = GateResult | FillGateResult


def key_match_model(match: KeyMatch | None) -> ExtendKeyMatch | None:
    """The schema's ``keyMatch`` from a gate's :class:`KeyMatch`."""
    if match is None:
        return None
    return ExtendKeyMatch(
        detected=MusicalKey(
            tonic=NOTE_NAMES[match.detected.tonic_pc],
            mode=KeyMode(match.detected.mode),
        ),
        confidence=match.confidence,
        relation=ExtendKeyRelation(match.relation),
        shiftSemitones=match.shift_semitones,
    )


def match_eq_model(eq: MatchEq | None) -> ExtendMatchEq | None:
    """The schema's ``matchEq`` from a gate's :class:`MatchEq`."""
    if eq is None:
        return None
    return ExtendMatchEq(bands=list(eq.bands), amount=eq.amount)


def step_models(gate: AnyGate) -> list[ExtendStep]:
    """Every gate verdict as the schema's ``ExtendStep``."""
    return [
        ExtendStep(
            step=verdict.step,
            passed=verdict.passed,
            skipped=verdict.skipped,
            reason=verdict.reason,
            metrics=metrics(verdict.metrics),
        )
        for verdict in gate.steps
    ]


def metrics(values: Mapping[str, object]) -> dict[str, object]:
    """Gate metrics as JSON values: non-finite floats become ``null``."""
    clean: dict[str, object] = {}
    for name, value in values.items():
        if isinstance(value, bool | int | str):
            clean[name] = value
        elif isinstance(value, float):
            clean[name] = value if math.isfinite(value) else None
        else:
            item = getattr(value, "item", None)
            clean[name] = item() if callable(item) else str(value)
    return clean


async def upload(
    ctx: JobContext,
    processed: Audio,
    build: Callable[[str], BaseModel],
    *,
    required: Sequence[str] = (),
) -> tuple[str, str]:
    """Uploads the audio and its blob; returns ``(asset hash, blob hash)``.

    ``build`` receives the asset hash and returns the result document. The
    required-but-nullable fields in ``required`` are re-added after
    ``exclude_none``: ``seamScore``/``endSeamScore`` are required and ``null`` is
    meaningful (the gates could not score the candidate), unlike the optional
    ``keyMatch``/``matchEq``.
    """
    data = await asyncio.to_thread(encode_flac, processed)
    asset = await ctx.upload(data, "audio/flac")
    document = build(asset)
    dumped = document.model_dump(mode="json", exclude_none=True)
    for name in required:
        dumped[name] = getattr(document, name)
    blob = await ctx.upload_json(json.dumps(dumped, separators=(",", ":")))
    return asset, blob


__all__ = ["AnyGate", "key_match_model", "match_eq_model", "metrics", "step_models", "upload"]
