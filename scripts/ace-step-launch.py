"""Launch the ACE-Step 1.5 REST API on PyTorch/MPS.

ACE-Step 1.5 auto-selects native MLX for DiT and VAE on Apple Silicon, and its
API server has no flag to opt out. The WP-2.7 A1 spike pins the portable
PyTorch/MPS path instead, so this launcher turns both MLX backends off before
the FastAPI app is imported. ``scripts/ace-step-serve.sh`` calls it; the pinned
checkout is never modified.
"""

from __future__ import annotations

import os

import uvicorn


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
    """Run uvicorn exactly like ``acestep-api`` does, but without MLX."""
    force_pytorch_backends()
    uvicorn.run(
        "acestep.api_server:app",
        host=os.getenv("ACESTEP_API_HOST", "127.0.0.1"),
        port=int(os.getenv("ACESTEP_API_PORT", "8001")),
        reload=False,
        workers=1,
    )


if __name__ == "__main__":
    main()
