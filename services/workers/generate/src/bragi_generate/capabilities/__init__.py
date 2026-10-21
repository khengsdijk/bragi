"""Generation capabilities (``specs/09-generation.md`` §2).

One module per capability, exposing ``CAPABILITY``, ``ParamsModel`` and
``run(job, ctx)`` (13 §3). Only ``generate.extend`` is implemented in WP-2.7.
"""

from __future__ import annotations

from bragi_generate.capabilities import extend

__all__ = ["extend"]
