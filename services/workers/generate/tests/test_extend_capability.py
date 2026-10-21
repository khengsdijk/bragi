"""The ``generate.extend`` capability end to end, without NATS or a model."""

from __future__ import annotations

import json
from typing import cast

import pytest
from extend_support import (
    FakeContext,
    StubBackend,
    context_bytes,
    gate,
    make_job,
    params,
    run_async,
)

from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import GenerateExtendParams, GenerateExtendResult
from bragi_generate import routing
from bragi_generate.backends.fake import FakeBackend
from bragi_generate.capabilities import extend
from bragi_generate.postprocess import Audio, GateRequest, GateResult


def use_backend(monkeypatch: pytest.MonkeyPatch, backend: StubBackend | FakeBackend) -> None:
    """Routes every request to ``backend`` through the documented env override."""
    monkeypatch.setenv(routing.ENV_OVERRIDE, "fake")
    monkeypatch.setattr(routing, "BACKEND_FACTORIES", {"fake": lambda: backend})


def test_the_capability_contract() -> None:
    assert extend.CAPABILITY == "generate.extend"
    assert extend.ParamsModel is GenerateExtendParams
    with pytest.raises(ValueError, match="less than or equal to 4"):
        extend.ParamsModel.model_validate({**params(), "n": 5})


def test_partials_stream_in_order_and_the_outputs_match_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        extend, "run_gates", lambda candidate, _context, _req: gate(candidate, passed=True)
    )
    ctx = FakeContext(context_bytes())

    outputs = run_async(extend.run(make_job(params(n=3)), cast(JobContext, ctx)))

    assert backend.seeds == [1234, 1235, 1236]
    assert [sorted(partial.assets or {}) for partial in ctx.partials] == [
        ["candidate_0"],
        ["candidate_1"],
        ["candidate_2"],
    ]
    assert outputs.assets is not None and outputs.blobs is not None
    assert sorted(outputs.assets) == ["candidate_0", "candidate_1", "candidate_2"]
    assert sorted(outputs.blobs) == ["candidate_0", "candidate_1", "candidate_2"]

    results = [
        GenerateExtendResult.model_validate_json(ctx.uploads[outputs.blobs[f"candidate_{index}"]])
        for index in range(3)
    ]
    assert [result.index for result in results] == [0, 1, 2]
    assert all(result.passed for result in results)
    assert all(result.qualityWarning is False for result in results)
    assert all(result.seamScore == pytest.approx(0.2) for result in results)
    assert all(result.model == "fake" and result.modelVersion == "1" for result in results)
    assert all(result.steps[0].step == "sanity" for result in results)
    assert ctx.metrics is not None
    assert ctx.metrics.model == "fake" and ctx.metrics.gpuSeconds > 0.0
    assert ctx.reports[-1] == 1.0 and ctx.reports == sorted(ctx.reports)


def test_failed_candidates_are_regenerated_with_new_seeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubBackend()
    use_backend(monkeypatch, backend)
    calls = {"count": 0}

    def gated(candidate: Audio, _context: Audio, _req: GateRequest) -> GateResult:
        calls["count"] += 1
        return gate(candidate, passed=calls["count"] > 2)

    monkeypatch.setattr(extend, "run_gates", gated)
    ctx = FakeContext(context_bytes())

    outputs = run_async(extend.run(make_job(params(n=2)), cast(JobContext, ctx)))

    # Round 0 fails both; round 1 requests two again, with distinct new seeds.
    assert backend.seeds == [1234, 1235, 1250, 1251]
    assert len(ctx.partials) == 2
    assert outputs.assets is not None and len(outputs.assets) == 2


def test_none_passing_returns_the_best_with_a_json_safe_seam_score(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        extend,
        "run_gates",
        lambda candidate, _context, _req: gate(candidate, passed=False, seam=float("inf")),
    )
    ctx = FakeContext(context_bytes())

    outputs = run_async(extend.run(make_job(params(n=1)), cast(JobContext, ctx)))

    assert not ctx.partials  # rejected audio is never streamed
    assert outputs.assets is not None and outputs.blobs is not None
    assert len(outputs.assets) == 1
    result = GenerateExtendResult.model_validate_json(ctx.uploads[outputs.blobs["candidate_0"]])
    assert result.passed is False
    assert result.qualityWarning is True
    assert result.seamScore is None
    assert result.tempoError == pytest.approx(0.01)
    assert json.loads(ctx.uploads[outputs.blobs["candidate_0"]])["seamScore"] is None
    assert ctx.metrics is not None


def test_cancellation_stops_before_the_next_candidate(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = StubBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        extend, "run_gates", lambda candidate, _context, _req: gate(candidate, passed=True)
    )
    ctx = FakeContext(context_bytes(), cancel_after=1)

    with pytest.raises(JobCancelledError):
        run_async(extend.run(make_job(params(n=3)), cast(JobContext, ctx)))

    assert backend.seeds == [1234]
    assert len(ctx.partials) == 1


def test_the_real_gates_pass_on_a_fake_continuation(monkeypatch: pytest.MonkeyPatch) -> None:
    use_backend(monkeypatch, FakeBackend("synth"))
    ctx = FakeContext(context_bytes(12.0))
    document = params(bars=4, overlap_bars=2, n=3)
    document["context"] = {
        **cast("dict[str, object]", document["context"]),
        "seed": 1234,
    }

    outputs = run_async(extend.run(make_job(document), cast(JobContext, ctx)))

    assert [sorted(partial.assets or {}) for partial in ctx.partials] == [
        ["candidate_0"],
        ["candidate_1"],
        ["candidate_2"],
    ]
    assert outputs.assets is not None and outputs.blobs is not None
    for index in range(3):
        result = GenerateExtendResult.model_validate_json(
            ctx.uploads[outputs.blobs[f"candidate_{index}"]]
        )
        assert result.passed, [(step.step, step.reason) for step in result.steps]
        assert result.seamScore is not None and result.seamScore >= 0.0
        assert result.keyMatch is not None
        assert result.matchEq is not None
        assert result.direction.value == "forward"
    assert ctx.metrics is not None and ctx.metrics.gpuSeconds > 0.0


def test_the_context_asset_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    use_backend(monkeypatch, StubBackend())
    job = make_job(params())
    job.inputs.assets.pop("context")
    with pytest.raises(ValueError, match=r"inputs\.assets\.context"):
        run_async(extend.run(job, cast(JobContext, FakeContext(context_bytes()))))


def test_a_top_level_seed_overrides_the_context_seed(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = StubBackend()
    use_backend(monkeypatch, backend)
    monkeypatch.setattr(
        extend, "run_gates", lambda candidate, _context, _req: gate(candidate, passed=True)
    )
    # An HQ re-render sends the accepted candidate's seed this way (09 §5).
    document = {**params(n=1), "seed": 4321, "tier": "hq"}

    run_async(extend.run(make_job(document), cast(JobContext, FakeContext(context_bytes()))))

    assert backend.seeds == [4321]
