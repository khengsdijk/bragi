"""Postprocess quality gates for generated audio (``specs/09-generation.md`` §6).

One entry point, seven steps, in the order the spec fixes:

1. :mod:`.sanity` — silence, clipping, NaN/Inf;
2. :mod:`.tempo` — beat-track, reject a >4 % error, WSOLA-warp the rest;
3. :mod:`.tonality` — key check with the ±1 semitone repair;
4. :mod:`.alignment` — onset-envelope cross-correlation of the overlap;
5. :mod:`.seam` — splice search minimising 03 §8.2's seam score, then an
   equal-power crossfade with a phase-aware offset;
6. :mod:`.match` — loudness ramp and the 31-band ``match_eq`` result;
7. :mod:`.pipeline` — the final seam score and the verdicts.

```python
result = postprocess(candidate, context, request)
if result.passed:
    place(result.processed, at=result.splice_offset_samples)
```
"""

from __future__ import annotations

from bragi_generate.postprocess.config import GateConfig, default_path
from bragi_generate.postprocess.pipeline import postprocess
from bragi_generate.postprocess.types import (
    NOTE_NAMES,
    Audio,
    GateRequest,
    GateResult,
    KeyMatch,
    KeySpec,
    MatchEq,
    StepVerdict,
)

__all__ = [
    "NOTE_NAMES",
    "Audio",
    "GateConfig",
    "GateRequest",
    "GateResult",
    "KeyMatch",
    "KeySpec",
    "MatchEq",
    "StepVerdict",
    "default_path",
    "postprocess",
]
