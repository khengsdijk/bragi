"""The analysis worker process: registers its capabilities and runs.

The CPU ``worker`` service in ``infra/docker-compose.yml`` runs this entrypoint.
Real analysis capabilities (``specs/04``) join the same list: ``ingest``, ``rhythm`` and
``loudness_energy`` (WP-1.2), ``analysis.separation`` (WP-1.3), ``structure`` (WP-1.4),
``analysis.harmony`` (WP-1.5), the embedding/tagging/stem-activity group (WP-1.6), plus
``echo``, the framework's smoke test.
"""

from __future__ import annotations

from collections.abc import Sequence

from bragi_analysis.capabilities import (
    echo,
    embed_full,
    harmony,
    ingest,
    loudness_energy,
    rhythm,
    section_embed,
    separation,
    stem_activity,
    stem_embed,
    structure,
    tag,
)
from bragi_common.config import Settings
from bragi_common.protocol import Capability
from bragi_common.worker import run_worker

#: Every capability this process serves (13 §3: one module per capability).
CAPABILITIES: Sequence[Capability] = [
    echo,
    embed_full,
    harmony,
    ingest,
    loudness_energy,
    rhythm,
    section_embed,
    separation,
    stem_activity,
    stem_embed,
    structure,
    tag,
]


def main() -> None:
    """Runs the worker until SIGTERM (05 §4.3)."""
    run_worker(Settings(), CAPABILITIES)
