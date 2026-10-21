"""The fake backend: protocol conformance and gate-friendly synthesis."""

from __future__ import annotations

import numpy as np
import pytest
from extend_support import context_audio, key

from bragi_generate.audio import rms_db
from bragi_generate.backend import Direction, FillRequest, GenRequest
from bragi_generate.backends.fake import FakeBackend, fill_contexts, synthesize
from bragi_generate.postprocess import GateRequest, postprocess

RATE = 48_000


def request(
    *,
    bars: int = 4,
    overlap_bars: int = 2,
    direction: Direction = "forward",
    seed: int = 1234,
    context_seconds: float = 12.0,
) -> GenRequest:
    context = synthesize(120.0, (4, 4), key(), start_sec=0.0, duration_sec=context_seconds, seed=99)
    return GenRequest(
        capability="generate.extend",
        context=context,
        bpm=120.0,
        time_signature=(4, 4),
        key=key(),
        bars=bars,
        overlap_bars=overlap_bars,
        direction=direction,
        descriptors=("warm analog synths",),
        seed=seed,
    )


def test_fake_backend_conforms_to_the_protocol() -> None:
    backend = FakeBackend("synth")
    assert backend.name == "fake"
    assert backend.version == "1"
    assert backend.capabilities == frozenset(
        {"generate.extend", "generate.inpaint", "generate.transition"}
    )
    assert backend.supports_audio_context
    assert backend.supports_preview_tier
    assert backend.max_duration_sec >= 60.0


def test_generate_returns_the_overlap_plus_the_new_bars() -> None:
    backend = FakeBackend("synth")
    outputs = backend.generate(request(), "preview", 2, lambda _pct: None)

    assert len(outputs) == 2
    for output in outputs:
        assert output.audio.sample_rate == RATE
        assert output.audio.samples.shape[1] == 2
        # 4 new bars + 2 overlap at 120 BPM in 4/4: 12 s.
        assert output.audio.duration_sec == pytest.approx(12.0, abs=0.001)
        assert output.model == "fake"
        assert output.timings.total_sec >= 0.0


def test_the_same_seed_is_bit_identical_and_a_new_one_is_not() -> None:
    backend = FakeBackend("synth")
    first = backend.generate(request(seed=7), "preview", 1, lambda _pct: None)[0]
    again = backend.generate(request(seed=7), "preview", 1, lambda _pct: None)[0]
    other = backend.generate(request(seed=8), "preview", 1, lambda _pct: None)[0]

    assert np.array_equal(first.audio.samples, again.audio.samples)
    assert not np.array_equal(first.audio.samples, other.audio.samples)


def test_the_output_continues_the_context_loudness() -> None:
    req = request()
    output = FakeBackend("synth").generate(req, "preview", 1, lambda _pct: None)[0]

    assert rms_db(output.audio) == pytest.approx(rms_db(req.context), abs=1.0)


@pytest.mark.parametrize("direction", ["forward", "backward"])
def test_a_synthetic_continuation_passes_every_gate(direction: Direction) -> None:
    req = request(direction=direction)
    output = FakeBackend("synth").generate(req, "preview", 1, lambda _pct: None)[0]
    gate = GateRequest(
        bpm=req.bpm,
        time_signature=req.time_signature,
        key=req.key,
        bars=req.bars,
        overlap_bars=req.overlap_bars,
        direction=req.direction,
    )

    result = postprocess(output.audio, req.context, gate)

    assert result.passed, [(step.step, step.reason) for step in result.steps]
    assert result.quality_warning is False
    assert np.isfinite(result.seam_score)


def test_progress_reaches_one_per_candidate() -> None:
    seen: list[float] = []
    FakeBackend("synth").generate(request(), "preview", 3, seen.append)
    assert seen == [pytest.approx(1 / 3), pytest.approx(2 / 3), pytest.approx(1.0)]


def offbeat_request(direction: Direction = "forward", seed: int = 1234) -> GenRequest:
    """A context whose bars do not start at a whole second, like a real song's tail."""
    req = request(direction=direction, seed=seed)
    context = synthesize(120.0, (4, 4), key(), start_sec=0.37, duration_sec=12.0, seed=99)
    return GenRequest(
        capability=req.capability,
        context=context,
        bpm=req.bpm,
        time_signature=req.time_signature,
        key=req.key,
        bars=req.bars,
        overlap_bars=req.overlap_bars,
        direction=direction,
        descriptors=req.descriptors,
        seed=seed,
    )


@pytest.mark.parametrize("direction", ["forward", "backward"])
def test_a_loop_starts_with_the_context_edge(direction: Direction) -> None:
    req = offbeat_request(direction)
    audio = FakeBackend("loop").generate(req, "preview", 1, lambda _pct: None)[0].audio
    overlap = round(req.overlap_sec * RATE)

    assert audio.duration_sec == pytest.approx(req.total_duration_sec, abs=0.001)
    gain = 10.0 ** (((req.seed % 11) - 5) / 10.0 / 20.0)
    if direction == "forward":
        expected, got = req.context.samples[-overlap:], audio.samples[:overlap]
    else:
        expected, got = req.context.samples[:overlap], audio.samples[-overlap:]
    np.testing.assert_allclose(got, expected * np.float32(gain), atol=1e-6)


@pytest.mark.parametrize("direction", ["forward", "backward"])
def test_every_seeded_loop_passes_every_gate_off_the_grid(direction: Direction) -> None:
    req = offbeat_request(direction)
    outputs = FakeBackend("loop").generate(req, "preview", 3, lambda _pct: None)
    gate = GateRequest(
        bpm=req.bpm,
        time_signature=req.time_signature,
        key=req.key,
        bars=req.bars,
        overlap_bars=req.overlap_bars,
        direction=req.direction,
    )

    assert len({output.audio.samples.tobytes() for output in outputs}) == 3
    for output in outputs:
        result = postprocess(output.audio, req.context, gate)
        assert result.passed, [(step.step, step.reason) for step in result.steps]


def test_the_mode_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BRAGI_FAKE_GENERATION", raising=False)
    assert FakeBackend().mode == "loop"
    monkeypatch.setenv("BRAGI_FAKE_GENERATION", "synth")
    assert FakeBackend().mode == "synth"
    monkeypatch.setenv("BRAGI_FAKE_GENERATION", "noise")
    with pytest.raises(ValueError, match="loop or synth"):
        FakeBackend()


def fill_request(
    *,
    gap_bars: int = 2,
    lead_bars: float = 0.0,
    overlap_bars: int = 1,
    seed: int = 1234,
) -> FillRequest:
    """A two-sided request on two synthetic A-minor contexts."""
    before = context_audio(12.0)
    after = context_audio(12.0, seed=100)
    return FillRequest(
        capability="generate.inpaint",
        before=before,
        after=after,
        bpm=120.0,
        time_signature=(4, 4),
        key=key(),
        gap_bars=gap_bars,
        lead_bars=lead_bars,
        overlap_bars=overlap_bars,
        descriptors=("warm analog synths",),
        seed=seed,
    )


def test_fill_contexts_have_the_span_and_both_overlaps() -> None:
    req = fill_request(gap_bars=2, overlap_bars=1)
    audio = fill_contexts(req, seed=5)
    overlap = round(req.overlap_sec * RATE)

    assert audio.duration_sec == pytest.approx(req.total_duration_sec, abs=0.001)
    # Seed 5 has a unit gain, so the head is an exact re-creation. The tail's first
    # crossfade length is the blend into the right context; from there it is exact.
    fade = round(min(req.beat_sec, 0.5) * RATE)
    np.testing.assert_allclose(audio.samples[:overlap], req.before.samples[-overlap:], atol=1e-6)
    np.testing.assert_allclose(
        audio.samples[-overlap + fade :], req.after.samples[fade:overlap], atol=1e-6
    )


def test_fill_contexts_are_deterministic_per_seed() -> None:
    first = fill_contexts(fill_request(), seed=7)
    again = fill_contexts(fill_request(), seed=7)
    other = fill_contexts(fill_request(), seed=8)

    assert np.array_equal(first.samples, again.samples)
    assert not np.array_equal(first.samples, other.samples)


def test_a_transition_fill_recreates_the_contexts_around_the_span() -> None:
    req = fill_request(gap_bars=0, lead_bars=1.0, overlap_bars=1)
    audio = fill_contexts(req, seed=5)
    overlap = round(req.overlap_sec * RATE)
    lead = round(req.lead_sec * RATE)

    # The head is the audio before the span start, the tail the audio after its end.
    np.testing.assert_allclose(
        audio.samples[:overlap], req.before.samples[-lead - overlap : -lead], atol=1e-6
    )
    fade = round(min(req.beat_sec, 0.5) * RATE)
    np.testing.assert_allclose(
        audio.samples[-overlap + fade :], req.after.samples[lead + fade : lead + overlap], atol=1e-6
    )


def test_the_fake_backend_generates_fill_candidates() -> None:
    req = fill_request(gap_bars=2)
    outputs = FakeBackend().generate_fill(req, "preview", 3, lambda _pct: None)

    assert len(outputs) == 3
    assert len({output.audio.samples.tobytes() for output in outputs}) == 3
    for output in outputs:
        assert output.audio.duration_sec == pytest.approx(req.total_duration_sec, abs=0.001)
        assert output.model == "fake" and output.model_version == "1"
        assert output.timings.total_sec >= 0.0


def test_a_fill_cannot_be_longer_than_its_contexts() -> None:
    req = fill_request(gap_bars=2, lead_bars=6.0, overlap_bars=1)
    with pytest.raises(ValueError, match="lead plus the overlap"):
        fill_contexts(req, seed=0)
