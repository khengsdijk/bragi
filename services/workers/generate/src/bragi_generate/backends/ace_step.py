"""The ``generate.extend`` adapter for ACE-Step 1.5 (``specs/09-generation.md`` §3.1).

ACE-Step runs as its own process; this adapter is the bridge between the
capability's musical request and its ``repaint`` task. Two mappings matter:

* **Forward** is a repaint that starts one overlap before the context ends and
  ends ``bars`` later. ACE-Step pads the source with silence on the right and
  returns the whole timeline; the candidate is its tail.
* **Backward** is client-side (A1 spike): prepend the new span's worth of silence,
  then repaint ``[0, new + overlap]``. ACE-Step preserves everything after the
  span, so the original song is untouched and the generated intro ends with a
  re-created overlap for the splice search.
* **A fill** (WP-2.8: inpaint and transition) is the middle-span form: the source is
  ``before + gap + after`` (the gap is silence for an inpaint and empty for a
  transition), and ``[span_start, span_end]`` covers the span plus one overlap on
  each side. ACE-Step's waveform splice keeps everything outside the span, so the
  candidate is the span only and both of its ends re-create their context
  (``acestep/core/generation/handler/repaint_waveform_splice.py``).

ACE normalises its whole output to -1 dBFS in the HTTP path and gains the
preserved context accordingly (A1 measured 0.89 to 1.78). The candidate is divided by
the gain measured on the untouched context part, so the gates compare levels that
are actually comparable; the gate pass then does its own loudness match.
"""

from __future__ import annotations

import os
import tempfile
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np

from bragi_generate.audio import decode, encode_wav, rms, scale
from bragi_generate.backend import FillRequest, GenOutput, GenRequest, GenTimings, Tier
from bragi_generate.backends.ace_step_api import (
    DEFAULT_BASE_URL,
    AceStepClient,
    RepaintRequest,
)
from bragi_generate.postprocess.types import NOTE_NAMES, Audio, KeySpec

#: The pinned model's version (``scripts/ace-step-setup.sh``: ace-step 1.5.0).
MODEL_VERSION: Final = "1.5.0"
#: Name reported in ``GenOutput`` and the job metrics.
MODEL_NAME: Final = "ace-step"

RELATIVE_PATH: Final = Path("config/generation_backends.toml")
PATH_ENV: Final = "BRAGI_GENERATION_BACKENDS"
URL_ENV: Final = "BRAGI_ACE_STEP_URL"


def default_path() -> Path:
    """The backend config: ``$BRAGI_GENERATION_BACKENDS``, else the repo root's."""
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
class AceStepConfig:
    """Steps per tier and the server address, with the same defaults as the TOML."""

    base_url: str = DEFAULT_BASE_URL
    preview_steps: int = 4
    hq_steps: int = 8
    poll_interval_sec: float = 1.0
    timeout_sec: float = 600.0

    def __post_init__(self) -> None:
        """Rejects a setting the API cannot use."""
        if not 1 <= self.preview_steps <= 200:
            raise ValueError("preview_steps must be in 1..200")
        if not 1 <= self.hq_steps <= 200:
            raise ValueError("hq_steps must be in 1..200")
        if self.poll_interval_sec <= 0.0 or self.timeout_sec <= 0.0:
            raise ValueError("poll_interval_sec and timeout_sec must be positive")

    @classmethod
    def load(cls, path: Path | str | None = None) -> AceStepConfig:
        """Reads the TOML file, falling back to the defaults for absent keys."""
        source = Path(path) if path is not None else default_path()
        with source.open("rb") as handle:
            raw = tomllib.load(handle)
        section = raw.get("ace_step")
        if section is None:
            section = {}
        if not isinstance(section, dict):
            raise ValueError("[ace_step] must be a table")
        defaults = cls()
        base_url = os.environ.get(URL_ENV) or _str(section, "base_url", defaults.base_url)
        return cls(
            base_url=base_url,
            preview_steps=_int(section, "preview_steps", defaults.preview_steps),
            hq_steps=_int(section, "hq_steps", defaults.hq_steps),
            poll_interval_sec=_float(section, "poll_interval_sec", defaults.poll_interval_sec),
            timeout_sec=_float(section, "timeout_sec", defaults.timeout_sec),
        )

    def steps_for(self, tier: Tier) -> int:
        """Diffusion steps of a latency tier (09 §5)."""
        return self.preview_steps if tier == "preview" else self.hq_steps


def _str(section: dict[str, object], name: str, default: str) -> str:
    value = section.get(name, default)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string, got {value!r}")
    return value


def _int(section: dict[str, object], name: str, default: int) -> int:
    value = section.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer, got {value!r}")
    return value


def _float(section: dict[str, object], name: str, default: float) -> float:
    value = section.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{name} must be a number, got {value!r}")
    return float(value)


def ace_key(key: KeySpec) -> str:
    """ACE-Step's key spelling: ``"Am"``, ``"C"`` (sharps, like the analysis)."""
    return NOTE_NAMES[key.tonic_pc] + ("m" if key.mode == "minor" else "")


def caption_for(req: GenRequest | FillRequest, *, limit: int = 500) -> str:
    """The text conditioning: descriptors, then the user's prompt.

    The planner/API rewrite artist names into descriptors before a job exists
    (10 §7); there is no Python-side blocklist to apply here yet, so this only
    composes what it is given.
    """
    parts = [descriptor.strip() for descriptor in req.descriptors if descriptor.strip()]
    if req.prompt is not None and req.prompt.strip():
        parts.append(req.prompt.strip())
    return ", ".join(parts)[:limit]


def _gain_against(preserved: Audio, source: Audio) -> float:
    """ACE's normalisation gain, measured on the part it preserved exactly."""
    source_level = rms(source)
    if source_level < 1e-6:
        return 1.0
    gain = rms(preserved) / source_level
    return gain if 0.05 <= gain <= 20.0 else 1.0


def _fit(audio: Audio, frames: int) -> Audio:
    """The candidate exactly ``frames`` long, zero-padded or trimmed at the end."""
    samples = audio.samples
    if samples.shape[0] >= frames:
        return Audio(np.ascontiguousarray(samples[:frames]), audio.sample_rate)
    padding = np.zeros((frames - samples.shape[0], samples.shape[1]), dtype=np.float32)
    return Audio(np.ascontiguousarray(np.concatenate([samples, padding])), audio.sample_rate)


class AceStepBackend:
    """``GenerationBackend`` over the local ACE-Step REST API."""

    name = MODEL_NAME
    version = MODEL_VERSION
    capabilities = frozenset({"generate.extend", "generate.inpaint", "generate.transition"})
    max_duration_sec = 600.0
    supports_audio_context = True
    supports_lyrics = True
    supports_preview_tier = True

    def __init__(
        self,
        client: AceStepClient | None = None,
        config: AceStepConfig | None = None,
    ) -> None:
        """Binds the adapter to a config and, optionally, an injected client (tests)."""
        self._config = config if config is not None else AceStepConfig.load()
        self._client = (
            client
            if client is not None
            else AceStepClient(self._config.base_url, timeout_sec=self._config.timeout_sec)
        )

    @property
    def config(self) -> AceStepConfig:
        """The settings this adapter uses."""
        return self._config

    def generate(
        self,
        req: GenRequest,
        tier: Tier,
        n: int,
        on_progress: Callable[[float], None],
    ) -> list[GenOutput]:
        """Runs ``n`` seeded repaints and returns their trimmed candidates."""
        self._check("generate.extend", req.context, tier, n)

        steps = self._config.steps_for(tier)
        started = time.perf_counter()
        outputs: list[GenOutput] = []
        with tempfile.TemporaryDirectory(prefix="bragi-ace-") as directory:
            scratch = Path(directory)
            for index in range(n):
                seed = (req.seed + index) & 0xFFFFFFFF
                candidate, download_sec = self._one(req, scratch, index, seed, steps)
                outputs.append(
                    GenOutput(
                        audio=candidate,
                        seed=seed,
                        model=self.name,
                        model_version=self.version,
                        timings=GenTimings(
                            generate_sec=time.perf_counter() - started,
                            download_sec=download_sec,
                            total_sec=time.perf_counter() - started,
                        ),
                    )
                )
                on_progress((index + 1) / n)
        return outputs

    def generate_fill(
        self,
        req: FillRequest,
        tier: Tier,
        n: int,
        on_progress: Callable[[float], None],
    ) -> list[GenOutput]:
        """Runs ``n`` seeded middle-span repaints for an inpaint or a transition."""
        if req.capability not in self.capabilities:
            raise ValueError(f"{self.name} does not implement {req.capability}")
        self._check(req.capability, req.before, tier, n)
        if req.after.sample_rate != req.before.sample_rate:
            raise ValueError("the two contexts must share a sample rate")

        steps = self._config.steps_for(tier)
        started = time.perf_counter()
        outputs: list[GenOutput] = []
        with tempfile.TemporaryDirectory(prefix="bragi-ace-") as directory:
            scratch = Path(directory)
            for index in range(n):
                seed = (req.seed + index) & 0xFFFFFFFF
                candidate, download_sec = self._one_fill(req, scratch, index, seed, steps)
                outputs.append(
                    GenOutput(
                        audio=candidate,
                        seed=seed,
                        model=self.name,
                        model_version=self.version,
                        timings=GenTimings(
                            generate_sec=time.perf_counter() - started,
                            download_sec=download_sec,
                            total_sec=time.perf_counter() - started,
                        ),
                    )
                )
                on_progress((index + 1) / n)
        return outputs

    def _check(self, capability: str, context: Audio, tier: Tier, n: int) -> None:
        """The guards both generation calls share."""
        if capability not in self.capabilities:
            raise ValueError(f"{self.name} does not implement {capability}")
        if tier not in ("preview", "hq"):
            raise ValueError(f"unknown tier {tier!r}")
        if n < 1:
            raise ValueError(f"n must be >= 1, got {n}")
        if context.sample_rate != 48_000:
            raise ValueError(f"ACE-Step speaks 48 kHz, got {context.sample_rate}")

    def warmup(self) -> None:
        """Loads the DiT, VAE and text encoder through ``POST /v1/init`` (09 §5).

        ``/health`` succeeds before the model is loaded, so it is not the warm-up;
        ``/v1/init`` is. It blocks for 10-14 s on the M2 Pro / MPS (``docs/wp/2.7.md``).
        """
        self._client.health()
        self._client.init()

    def _one(
        self,
        req: GenRequest,
        scratch: Path,
        index: int,
        seed: int,
        steps: int,
    ) -> tuple[Audio, float]:
        """One candidate: write the source, repaint, undo the gain, trim."""
        rate = req.context.sample_rate
        overlap_frames = round(req.overlap_sec * rate)
        if req.direction == "forward":
            source = req.context
            span_start = req.context.frames - overlap_frames
            span_end = req.context.frames + round(req.new_duration_sec * rate)
        else:
            silence = np.zeros((round(req.new_duration_sec * rate), 2), dtype=np.float32)
            source = Audio(
                np.ascontiguousarray(np.concatenate([silence, req.context.samples])),
                rate,
            )
            span_start = 0
            span_end = round((req.new_duration_sec + req.overlap_sec) * rate)

        returned, download_sec = self._repaint(
            source, span_start, span_end, req, scratch, index, seed, steps
        )
        if req.direction == "forward":
            candidate = returned.trimmed(span_start)
            preserved_out = returned.trimmed(0, span_start)
            preserved_in = source.trimmed(0, span_start)
        else:
            candidate = returned.trimmed(0, span_end)
            preserved_out = returned.trimmed(span_end)
            preserved_in = source.trimmed(span_end)
        gain = _gain_against(preserved_out, preserved_in)
        candidate = scale(candidate, 1.0 / gain)
        return _fit(candidate, round(req.total_duration_sec * returned.sample_rate)), download_sec

    def _one_fill(
        self,
        req: FillRequest,
        scratch: Path,
        index: int,
        seed: int,
        steps: int,
    ) -> tuple[Audio, float]:
        """One two-sided candidate: repaint the middle of ``before + gap + after``.

        The span starts ``lead + overlap`` before the join and ends ``lead +
        overlap`` after it, so ACE-Step sees the left context, the gap (silence for
        an inpaint, the original audio for a transition) and the right context, and
        preserves everything outside the span sample for sample (A1/A2's explicit
        ``repainting_start``/``repainting_end``). The returned timeline is the whole
        source; the candidate is the span only.
        """
        rate = req.before.sample_rate
        overlap = round(req.overlap_sec * rate)
        lead = round(req.lead_sec * rate)
        gap = round(req.gap_sec * rate)
        if req.before.frames < lead + overlap:
            raise ValueError("the before context is shorter than the lead plus the overlap")
        if req.after.frames < lead + overlap:
            raise ValueError("the after context is shorter than the lead plus the overlap")
        silence = np.zeros((gap, req.before.samples.shape[1]), dtype=np.float32)
        source = Audio(
            np.ascontiguousarray(np.concatenate([req.before.samples, silence, req.after.samples])),
            rate,
        )
        span_start = req.before.frames - lead - overlap
        span_end = req.before.frames + gap + lead + overlap

        returned, download_sec = self._repaint(
            source, span_start, span_end, req, scratch, index, seed, steps
        )
        candidate = returned.trimmed(span_start, span_end)
        if span_start > 0:
            preserved_out = returned.trimmed(0, span_start)
            preserved_in = source.trimmed(0, span_start)
        else:
            preserved_out = returned.trimmed(span_end)
            preserved_in = source.trimmed(span_end)
        gain = _gain_against(preserved_out, preserved_in)
        candidate = scale(candidate, 1.0 / gain)
        return _fit(candidate, round(req.total_duration_sec * returned.sample_rate)), download_sec

    def _repaint(
        self,
        source: Audio,
        span_start: int,
        span_end: int,
        req: GenRequest | FillRequest,
        scratch: Path,
        index: int,
        seed: int,
        steps: int,
    ) -> tuple[Audio, float]:
        """Write ``source``, repaint ``[span_start, span_end]`` and return the timeline.

        ``download_sec`` is the time spent polling and downloading, not the model
        call, so it can sit next to ``generate_sec`` in :class:`GenTimings`.
        """
        rate = source.sample_rate
        source_path = scratch / f"source-{index}.wav"
        source_path.write_bytes(encode_wav(source))
        request = RepaintRequest(
            src_audio_path=str(source_path),
            src_duration_sec=source.duration_sec,
            start_sec=span_start / rate,
            end_sec=span_end / rate,
            caption=caption_for(req),
            bpm=round(req.bpm),
            key_scale=ace_key(req.key),
            time_signature=str(req.time_signature[0]),
            seed=seed,
            steps=steps,
            repaint_strength=0.5,
            output_format="wav32",
        )
        output_path = scratch / f"output-{index}.wav"
        downloaded = time.perf_counter()
        result = self._client.repaint(
            request,
            output_path,
            poll_interval_sec=self._config.poll_interval_sec,
            timeout_sec=self._config.timeout_sec,
        )
        download_sec = time.perf_counter() - downloaded
        returned = decode(result.audio)
        if returned.sample_rate != rate:
            raise ValueError(f"ACE-Step returned {returned.sample_rate} Hz, expected {rate} Hz")
        return returned, download_sec


__all__ = [
    "MODEL_NAME",
    "MODEL_VERSION",
    "AceStepBackend",
    "AceStepConfig",
    "ace_key",
    "caption_for",
    "default_path",
]
