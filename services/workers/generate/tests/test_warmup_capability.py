"""The ``generate.warmup`` capability (09 §5) without NATS or a model."""

from __future__ import annotations

from typing import cast

import pytest
from extend_support import FakeContext, StubBackend, make_job, run_async

from bragi_common.context import JobContext
from bragi_common.generated.models import GenerateWarmupParams
from bragi_generate import routing
from bragi_generate.capabilities import warmup


def use_backend(monkeypatch: pytest.MonkeyPatch, backend: StubBackend) -> None:
    """Routes the warm-up to ``backend`` through the documented env override."""
    monkeypatch.setenv(routing.ENV_OVERRIDE, "fake")
    monkeypatch.setattr(routing, "BACKEND_FACTORIES", {"fake": lambda: backend})


def test_the_capability_contract() -> None:
    assert warmup.CAPABILITY == "generate.warmup"
    assert warmup.ParamsModel is GenerateWarmupParams
    assert warmup.WARMUP_ROUTE == "generate.extend"
    with pytest.raises(ValueError, match="extra_forbidden"):
        warmup.ParamsModel.model_validate({"tier": "preview"})


def test_it_loads_the_routed_model_and_returns_no_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend = StubBackend()
    use_backend(monkeypatch, backend)
    ctx = FakeContext(b"")

    outputs = run_async(warmup.run(make_job({}), cast(JobContext, ctx)))

    assert backend.warms == 1
    assert outputs.assets is None and outputs.blobs is None
    assert ctx.reports == [1.0]
    assert ctx.partials == []
