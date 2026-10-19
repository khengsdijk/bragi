"""Beat trackers behind the :class:`~bragi_analysis.trackers.base.BeatTracker` seam."""

from __future__ import annotations

from bragi_analysis.trackers import beat_this
from bragi_analysis.trackers.base import BeatTracker
from bragi_analysis.trackers.dsp import DspTracker


def select(preference: str) -> BeatTracker:
    """Picks a tracker: ``beat_this``, ``dsp``, or ``auto`` (Beat This! when it can run).

    Raises:
        BeatThisUnavailableError: ``beat_this`` was demanded but cannot run here.
    """
    if preference == "dsp":
        return DspTracker()
    if preference == "beat_this" or (preference == "auto" and beat_this.is_available()):
        return beat_this.BeatThisTracker()
    return DspTracker()
