"""Launch the ACE-Step 1.5 REST API on PyTorch/MPS or MLX.

ACE-Step 1.5 auto-selects native MLX for DiT (and its VAE) on Apple Silicon, and
its API server has no flag to choose. ``BRAGI_ACE_STEP_ENGINE`` selects the engine
before the FastAPI app is imported:

* ``pytorch`` (the default) pins the portable PyTorch/MPS path by turning both MLX
  backends off (the A1 spike's setting); it measured faster for a 30 s extend on
  the M2 Pro, see ``docs/wp/2.7.md``;
* ``mlx`` leaves ACE-Step's Apple Silicon defaults alone.

``scripts/ace-step-serve.sh`` calls this launcher; the pinned checkout is never
modified.
"""

from __future__ import annotations

import os

import uvicorn

ENGINE_ENV = "BRAGI_ACE_STEP_ENGINE"
DEFAULT_ENGINE = "pytorch"


def force_pytorch_backends() -> None:
    """Patch ``initialize_service`` so DiT and VAE stay on PyTorch/MPS."""
    from acestep.handler import AceStepHandler

    original = AceStepHandler.initialize_service

    def initialize_service(handler, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["use_mlx_dit"] = False
        result = original(handler, *args, **kwargs)
        handler.use_mlx_dit = False
        handler.mlx_decoder = None
        handler.use_mlx_vae = False
        handler.mlx_vae = None
        return result

    AceStepHandler.initialize_service = initialize_service  # type: ignore[method-assign]


def main() -> None:
    """Run uvicorn exactly like ``acestep-api`` does, with the selected engine."""
    engine = os.getenv(ENGINE_ENV, DEFAULT_ENGINE).strip().lower()
    if engine == "pytorch":
        force_pytorch_backends()
    elif engine != "mlx":
        raise SystemExit(f"{ENGINE_ENV} must be 'mlx' or 'pytorch', got {engine!r}")
    os.environ[ENGINE_ENV] = engine
    uvicorn.run(
        "acestep.api_server:app",
        host=os.getenv("ACESTEP_API_HOST", "127.0.0.1"),
        port=int(os.getenv("ACESTEP_API_PORT", "8001")),
        reload=False,
        workers=1,
    )


if __name__ == "__main__":
    main()
