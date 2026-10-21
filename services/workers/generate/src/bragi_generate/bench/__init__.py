"""The generation bench (11-1: ``09 §9`` check 1; ``docs/wp/2.7.md`` task F1).

* :mod:`.fixtures` — five synthetic songs with known BPM, meter and key, rendered in
  code at run time (no committed audio, 13 §1.7);
* :mod:`.context` — a local ``JobContext`` so the capability runs without NATS/S3;
* :mod:`.runner` — the ``python -m bragi_generate.bench`` entry point;
* :mod:`.report` — the JSON report models, the aggregates and the machine label.
"""

from __future__ import annotations

__all__: list[str] = []
