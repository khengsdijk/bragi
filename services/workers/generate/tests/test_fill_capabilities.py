"""``generate.inpaint`` and ``generate.transition`` end to end, without NATS or a model."""

from __future__ import annotations

import json
from typing import cast

import pytest
from extend_support import (
    SAMPLE_RATE,
    FakeContext,
    StubFillBackend,
    context_bytes,
    fill_gate,
    inpaint_params,
    make_fill_job,
    run_async,
    transition_params,
)

from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    GenerateFillResult,
    GenerateInpaintParams,
    GenerateTransitionParams,
    JobRequest,
)
from bragi_generate import routing
from bragi_generate.audio import encode_wav
from bragi_generate.backends.fake import FakeBackend
from bragi_generate.bench import fixtures
from bragi_generate.capabilities import inpaint, transition
from bragi_generate.postprocess import Audio, FillGateResult


def use_backend(monkeypatch: pytest.MonkeyPatch, backend: StubFillBackend | FakeBackend) -> None:
    """Routes every request to ``backend`` through the documented env override."""
    monkeypatch.setenv(routing.ENV_OVERRIDE, "fake")
    monkeypatch.setattr(routing, "BACKEND_FACTORIES", {"fake": lambda: backend})


def test_the_inpaint_capability_contract() -> None:
    assert inpaint.CAPABILITY == "generate.inpaint"
    assert inpaint.ParamsModel is GenerateInpaintParams
    with pytest.raises(ValueError, match="less than or equal to 32"):
        inpaint.ParamsModel.model_validate({**inpaint_params(), "gapBars": 33})


def test_the_transition_capability_contract() -> None:
    assert transition.CAPABILITY == "generate.transition"
    assert transition.ParamsModel is GenerateTransitionParams
    with pytest.raises(ValueError, match="less than or equal to 4"):
        transition.ParamsModel.model_validate({**transition_params(), "lengthBars": 5})


def test_inpaint_partials_stream_and_the_blob_has_both_offsets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubFillBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        inpaint, "run_gates", lambda candidate, _b, _a, _req: fill_gate(candidate, passed=True)
    )
    before, after = context_bytes(), context_bytes()
    job = make_fill_job(inpaint.CAPABILITY, inpaint_params(n=3), before, after)
    ctx = FakeContext({job.inputs.assets["before"]: before, job.inputs.assets["after"]: after})

    outputs = run_async(inpaint.run(job, cast(JobContext, ctx)))

    assert backend.seeds == [1234, 1235, 1236]
    assert [sorted(partial.assets or {}) for partial in ctx.partials] == [
        ["candidate_0"],
        ["candidate_1"],
        ["candidate_2"],
    ]
    assert outputs.assets is not None and outputs.blobs is not None
    assert sorted(outputs.assets) == ["candidate_0", "candidate_1", "candidate_2"]
    for index in range(3):
        result = GenerateFillResult.model_validate_json(
            ctx.uploads[outputs.blobs[f"candidate_{index}"]]
        )
        assert result.index == index
        assert result.passed and result.qualityWarning is False
        assert result.seamScore == pytest.approx(0.2)
        assert result.endSeamScore == pytest.approx(0.3)
        assert result.startOffsetSamples == -256
        assert result.endOffsetSamples == 512
        assert result.model == "fake" and result.modelVersion == "1"
    assert ctx.metrics is not None and ctx.metrics.gpuSeconds > 0.0
    assert ctx.reports[-1] == 1.0 and ctx.reports == sorted(ctx.reports)


def test_the_backend_request_carries_the_gap_and_both_contexts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubFillBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        inpaint, "run_gates", lambda candidate, _b, _a, _req: fill_gate(candidate, passed=True)
    )
    job = make_fill_job(inpaint.CAPABILITY, inpaint_params(gap_bars=4, overlap_bars=2))

    run_async(inpaint.run(job, cast(JobContext, FakeContext(context_for(job)))))

    request = backend.seen[0]
    assert request.capability == "generate.inpaint"
    assert request.gap_bars == 4
    assert request.lead_bars == 0.0
    assert request.overlap_bars == 2
    assert request.total_duration_sec == pytest.approx((4 + 2 * 2) * 2.0)


def test_a_transition_leads_half_its_length(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = StubFillBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        transition, "run_gates", lambda candidate, _b, _a, _req: fill_gate(candidate, passed=True)
    )
    job = make_fill_job(transition.CAPABILITY, transition_params(length_bars=3))

    run_async(transition.run(job, cast(JobContext, FakeContext(context_for(job)))))

    request = backend.seen[0]
    assert request.capability == "generate.transition"
    assert request.gap_bars == 0
    assert request.lead_bars == pytest.approx(1.5)
    assert request.overlap_bars == transition.TRANSITION_OVERLAP_BARS
    assert request.middle_bars == pytest.approx(3.0)
    assert request.total_duration_sec == pytest.approx(
        (3.0 + 2.0 * transition.TRANSITION_OVERLAP_BARS) * 2.0
    )


def test_failed_candidates_are_regenerated_with_new_seeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubFillBackend()
    use_backend(monkeypatch, backend)
    calls = {"count": 0}

    def gated(candidate: Audio, _b: Audio, _a: Audio, _req: object) -> FillGateResult:
        calls["count"] += 1
        return fill_gate(candidate, passed=calls["count"] > 2)

    monkeypatch.setattr(inpaint, "run_gates", gated)
    job = make_fill_job(inpaint.CAPABILITY, inpaint_params(n=2))

    outputs = run_async(inpaint.run(job, cast(JobContext, FakeContext(context_for(job)))))

    assert backend.seeds == [1234, 1235, 1250, 1251]
    assert outputs.assets is not None and len(outputs.assets) == 2


def test_no_passing_candidate_returns_the_best_with_null_scores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubFillBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        inpaint,
        "run_gates",
        lambda candidate, _b, _a, _req: fill_gate(
            candidate, passed=False, seam=float("inf"), end_seam=float("inf")
        ),
    )
    job = make_fill_job(inpaint.CAPABILITY, inpaint_params(n=1))
    ctx = FakeContext(context_for(job))

    outputs = run_async(inpaint.run(job, cast(JobContext, ctx)))

    assert not ctx.partials
    assert outputs.blobs is not None
    data = ctx.uploads[outputs.blobs["candidate_0"]]
    result = GenerateFillResult.model_validate_json(data)
    assert result.passed is False
    assert result.qualityWarning is True
    assert result.seamScore is None and result.endSeamScore is None
    document = json.loads(data)
    assert document["seamScore"] is None and document["endSeamScore"] is None


def test_the_missing_after_context_is_named(monkeypatch: pytest.MonkeyPatch) -> None:
    use_backend(monkeypatch, StubFillBackend())
    job = make_fill_job(inpaint.CAPABILITY, inpaint_params())
    job.inputs.assets.pop("after")
    with pytest.raises(ValueError, match=r"inputs\.assets\.after"):
        run_async(
            inpaint.run(job, cast(JobContext, FakeContext(context_for(job, with_after=False))))
        )


def test_cancellation_stops_before_the_next_candidate(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = StubFillBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        inpaint, "run_gates", lambda candidate, _b, _a, _req: fill_gate(candidate, passed=True)
    )
    job = make_fill_job(inpaint.CAPABILITY, inpaint_params(n=3))
    ctx = FakeContext(context_for(job), cancel_after=1)

    with pytest.raises(JobCancelledError):
        run_async(inpaint.run(job, cast(JobContext, ctx)))

    assert backend.seeds == [1234]
    assert len(ctx.partials) == 1


def test_the_real_fake_fill_passes_on_a_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    use_backend(monkeypatch, FakeBackend())
    before, after = fixture_contexts(fixtures.by_id("pop"), gap_bars=4)
    job = make_fill_job(
        inpaint.CAPABILITY,
        inpaint_params(gap_bars=4, overlap_bars=1, n=1),
        encode_wav(before),
        encode_wav(after),
    )
    ctx = FakeContext(context_for(job))

    outputs = run_async(inpaint.run(job, cast(JobContext, ctx)))

    assert outputs.blobs is not None
    result = GenerateFillResult.model_validate_json(ctx.uploads[outputs.blobs["candidate_0"]])
    assert result.passed, [(step.step, step.reason) for step in result.steps]
    assert result.seamScore is not None and result.endSeamScore is not None
    assert result.startOffsetSamples < 0 and result.endOffsetSamples > 0
    assert result.keyMatch is not None and result.matchEq is not None


def test_the_real_fake_transition_passes_on_a_fixture(monkeypatch: pytest.MonkeyPatch) -> None:
    use_backend(monkeypatch, FakeBackend())
    before, after = fixture_contexts(fixtures.by_id("house"), gap_bars=0, boundary_bars=8)
    job = make_fill_job(
        transition.CAPABILITY,
        transition_params(length_bars=2, n=1),
        encode_wav(before),
        encode_wav(after),
    )
    ctx = FakeContext(context_for(job))

    outputs = run_async(transition.run(job, cast(JobContext, ctx)))

    assert outputs.blobs is not None
    result = GenerateFillResult.model_validate_json(ctx.uploads[outputs.blobs["candidate_0"]])
    assert result.passed, [(step.step, step.reason) for step in result.steps]
    assert result.startOffsetSamples < 0 and result.endOffsetSamples > 0


def context_for(job: JobRequest, *, with_after: bool = True) -> dict[str, bytes]:
    """The job's declared assets, served from one synthetic payload per side."""
    payloads = {job.inputs.assets["before"]: context_bytes()}
    if with_after:
        payloads[job.inputs.assets["after"]] = context_bytes()
    return payloads


def fixture_contexts(
    fixture: fixtures.Fixture,
    *,
    gap_bars: int = 4,
    boundary_bars: int = 8,
) -> tuple[Audio, Audio]:
    """A mid-song gap's two contexts, on bar lines, like the bench renders them."""
    song = fixture.render(SAMPLE_RATE)
    bar = round(fixture.bar_sec * SAMPLE_RATE)
    if gap_bars:
        start = (fixture.bars - gap_bars) // 2
        context_bars = min(
            max(2, round(15.0 / fixture.bar_sec)), start, fixture.bars - start - gap_bars
        )
        before = Audio(song.samples[(start - context_bars) * bar : start * bar], SAMPLE_RATE)
        after = Audio(
            song.samples[(start + gap_bars) * bar : (start + gap_bars + context_bars) * bar],
            SAMPLE_RATE,
        )
        return before, after
    boundary = fixture.bars // 2
    context_bars = min(boundary_bars, boundary, fixture.bars - boundary)
    before = Audio(song.samples[(boundary - context_bars) * bar : boundary * bar], SAMPLE_RATE)
    after = Audio(song.samples[boundary * bar : (boundary + context_bars) * bar], SAMPLE_RATE)
    return before, after


def test_the_worker_registers_both_two_sided_capabilities() -> None:
    from bragi_generate import worker

    names = [capability.CAPABILITY for capability in worker.CAPABILITIES]
    assert names == [
        "generate.extend",
        "generate.inpaint",
        "generate.transition",
        "generate.warmup",
    ]
