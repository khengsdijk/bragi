"""Generation capabilities (``specs/09-generation.md`` §2).

One module per capability, exposing ``CAPABILITY``, ``ParamsModel`` and
``run(job, ctx)`` (13 §3). ``generate.extend`` is the only user-facing capability in
WP-2.7; ``generate.warmup`` is internal (the API's warm-up ping, 09 §5).
"""

from __future__ import annotations

from bragi_generate.capabilities import extend, warmup

__all__ = ["extend", "warmup"]
