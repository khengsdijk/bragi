"""Thresholds and weights of the quality gates, from ``config/generation_gates.toml``.

The file lives at the repo root so the values are reviewable next to the other
configuration and can be changed without a release. It is read with the stdlib
``tomllib`` into a frozen dataclass; every field has the same default as the
checked-in file, so a test can run without it and a missing key is not an error.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Final

RELATIVE_PATH: Final = Path("config/generation_gates.toml")
#: Deployment override, for an image that mounts the file somewhere else.
PATH_ENV: Final = "BRAGI_GENERATION_GATES"


def default_path() -> Path:
    """The gate config: ``$BRAGI_GENERATION_GATES``, else the repo root above this module."""
    override = os.environ.get(PATH_ENV)
    if override:
        path = Path(override)
        if not path.is_file():
            raise FileNotFoundError(f"{PATH_ENV} points at a missing file: {path}")
        return path
    for parent in Path(__file__).resolve().parents:
        candidate = parent / RELATIVE_PATH
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"no {RELATIVE_PATH} above {Path(__file__).resolve()}")


@dataclass(frozen=True)
class GateConfig:
    """Every tunable of 09 §6 and 03 §8.2, with the reviewable defaults."""

    # --- 1. sanity -------------------------------------------------------------------------
    silence_frame_sec: float = 0.05
    silence_dbfs: float = -50.0
    silence_fraction: float = 0.5
    clip_level: float = 0.999
    clip_fraction: float = 0.001

    # --- 2. tempo conform ------------------------------------------------------------------
    tempo_max_error: float = 0.04

    # --- 3. key check ----------------------------------------------------------------------
    allow_relative_key: bool = True
    max_key_shift_semitones: int = 1

    # --- 4. beat align ---------------------------------------------------------------------
    align_bars: int = 2
    align_min_confidence: float = 0.5
    align_search_beats: float = 1.0

    # --- 5. splice search ------------------------------------------------------------------
    seam_window_sec: float = 0.5
    seam_flux_weight: float = 1.0
    seam_loudness_weight: float = 0.2
    seam_onset_weight: float = 0.5
    seam_max_score: float = 1.0
    crossfade_beats: float = 1.0
    crossfade_max_sec: float = 0.5
    crossfade_phase_search_sec: float = 0.010

    # --- 6. loudness + spectral match ------------------------------------------------------
    loudness_window_sec: float = 2.0
    loudness_max_gain_db: float = 24.0
    eq_bands: int = 31
    eq_max_db: float = 6.0

    def __post_init__(self) -> None:
        """Rejects a configuration that would make a gate meaningless."""
        if not 0.0 < self.silence_fraction <= 1.0:
            raise ValueError("silence_fraction must be in (0, 1]")
        if not 0.0 <= self.clip_fraction <= 1.0:
            raise ValueError("clip_fraction must be in [0, 1]")
        for name in ("tempo_max_error", "silence_frame_sec", "loudness_window_sec"):
            if getattr(self, name) <= 0.0:
                raise ValueError(f"{name} must be positive")
        if self.crossfade_beats <= 0.0 or self.crossfade_max_sec <= 0.0:
            raise ValueError("crossfade length must be positive")
        if self.eq_bands < 1:
            raise ValueError("eq_bands must be >= 1")

    @classmethod
    def load(cls, path: Path | str | None = None) -> GateConfig:
        """Reads the TOML file, falling back to the defaults for absent keys."""
        source = Path(path) if path is not None else default_path()
        with source.open("rb") as handle:
            raw = tomllib.load(handle)
        defaults = cls()
        sanity = _section(raw, "sanity")
        tempo = _section(raw, "tempo")
        key = _section(raw, "key")
        align = _section(raw, "beat_align")
        seam = _section(raw, "seam")
        crossfade = _section(raw, "crossfade")
        match = _section(raw, "match")
        return cls(
            silence_frame_sec=_float(sanity, "silence_frame_sec", defaults.silence_frame_sec),
            silence_dbfs=_float(sanity, "silence_dbfs", defaults.silence_dbfs),
            silence_fraction=_float(sanity, "silence_fraction", defaults.silence_fraction),
            clip_level=_float(sanity, "clip_level", defaults.clip_level),
            clip_fraction=_float(sanity, "clip_fraction", defaults.clip_fraction),
            tempo_max_error=_float(tempo, "max_error", defaults.tempo_max_error),
            allow_relative_key=_bool(key, "allow_relative", defaults.allow_relative_key),
            max_key_shift_semitones=_int(
                key, "max_shift_semitones", defaults.max_key_shift_semitones
            ),
            align_bars=_int(align, "window_bars", defaults.align_bars),
            align_min_confidence=_float(align, "min_confidence", defaults.align_min_confidence),
            align_search_beats=_float(align, "search_beats", defaults.align_search_beats),
            seam_window_sec=_float(seam, "window_sec", defaults.seam_window_sec),
            seam_flux_weight=_float(seam, "flux_weight", defaults.seam_flux_weight),
            seam_loudness_weight=_float(seam, "loudness_weight", defaults.seam_loudness_weight),
            seam_onset_weight=_float(seam, "onset_weight", defaults.seam_onset_weight),
            seam_max_score=_float(seam, "max_score", defaults.seam_max_score),
            crossfade_beats=_float(crossfade, "length_beats", defaults.crossfade_beats),
            crossfade_max_sec=_float(crossfade, "max_sec", defaults.crossfade_max_sec),
            crossfade_phase_search_sec=_float(
                crossfade, "phase_search_sec", defaults.crossfade_phase_search_sec
            ),
            loudness_window_sec=_float(match, "loudness_window_sec", defaults.loudness_window_sec),
            loudness_max_gain_db=_float(match, "max_gain_db", defaults.loudness_max_gain_db),
            eq_bands=_int(match, "eq_bands", defaults.eq_bands),
            eq_max_db=_float(match, "eq_max_db", defaults.eq_max_db),
        )


def _section(raw: dict[str, object], name: str) -> dict[str, object]:
    value = raw.get(name)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f"[{name}] must be a table")
    return {str(key): item for key, item in value.items()}


def _float(section: dict[str, object], name: str, default: float) -> float:
    value = section.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{name} must be a number, got {value!r}")
    return float(value)


def _int(section: dict[str, object], name: str, default: int) -> int:
    value = section.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer, got {value!r}")
    return value


def _bool(section: dict[str, object], name: str, default: bool) -> bool:
    value = section.get(name, default)
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean, got {value!r}")
    return value
