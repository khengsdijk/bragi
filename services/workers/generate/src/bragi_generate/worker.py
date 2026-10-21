"""The generation worker process: registers its capabilities and runs.

The local ``pnpm dev:backend`` runs this entrypoint, and a generation pool would run
one process per capability in production (05 §1). Real capabilities join the list as
they land: only ``generate.extend`` is implemented in WP-2.7 (09 §2).
"""

from __future__ import annotations

from collections.abc import Sequence

from bragi_common.config import Settings
from bragi_common.protocol import Capability
from bragi_common.worker import run_worker
from bragi_generate.capabilities import extend

#: Every capability this process serves (13 §3: one module per capability).
CAPABILITIES: Sequence[Capability] = [extend]


def main() -> None:
    """Runs the worker until SIGTERM (05 §4.3)."""
    run_worker(Settings(), CAPABILITIES)
