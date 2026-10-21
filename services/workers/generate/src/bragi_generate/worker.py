"""The generation worker process: registers its capabilities and runs.

The local ``pnpm dev:backend`` runs this entrypoint, and a generation pool would run
one process per capability in production (05 §1). Real capabilities join the list as
they land: ``generate.extend`` (WP-2.7), ``generate.inpaint`` and
``generate.transition`` (WP-2.8), plus the internal warm-up (09 §5).
"""

from __future__ import annotations

from collections.abc import Sequence

from bragi_common.config import Settings
from bragi_common.protocol import Capability
from bragi_common.worker import run_worker
from bragi_generate.capabilities import extend, inpaint, transition, warmup

#: Every capability this process serves (13 §3: one module per capability).
CAPABILITIES: Sequence[Capability] = [extend, inpaint, transition, warmup]


def main() -> None:
    """Runs the worker until SIGTERM (05 §4.3)."""
    run_worker(Settings(), CAPABILITIES)
