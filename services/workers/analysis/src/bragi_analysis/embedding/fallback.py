"""A deterministic, weight-free embedder (WP-1.6, ADR-0011).

This is **not** a semantic model. It exists so the embedding and tagging machinery can be built
and tested without CLAP weights, a GPU or a download. It gives the ``Embedder`` contract a
run-able implementation on CPU:

* every tag concept owns a fixed pseudo-random **unit basis vector** in R^512, seeded from the
  concept id with ``numpy.random.default_rng``, so the basis is stable across runs and machines;
* every concept owns a hand-written **audio profile** over interpretable DSP descriptors (band
  energy shares, transient/sustain ratio, spectral flatness, centroid, loudness);
* an audio vector is the L2-normalised activation-weighted sum of the basis, and a text vector is
  the same sum over the concepts its keywords hit. In 512-d the basis is near-orthogonal, so
  cosine similarity tracks **concept overlap** — enough to prove the zero-shot path and the
  ``"drums"`` ranking metric, and nothing more.

Results carry the model id ``bragi-concept-basis-1`` and are flagged low-confidence, so nothing
is mistaken for real CLAP output.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from itertools import pairwise

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.dsp.features import spectral_centroid_hz, stft_magnitude
from bragi_analysis.embedding import windows
from bragi_analysis.embedding.protocol import FALLBACK_MODEL

type F64 = NDArray[np.float64]

N_FFT = 2048
HOP = 512
#: Band edges (Hz) whose power share is a feature; the last band is open to Nyquist.
_BAND_EDGES = (20.0, 60.0, 250.0, 500.0, 2_000.0, 4_000.0, 9_000.0, 16_000.0)
_BAND_NAMES = ("sub", "bass", "lowmid", "mid", "highmid", "high", "air")
#: Below this the window is treated as digital silence (no concept activation).
SILENCE_RMS_DB = -80.0


@dataclass(frozen=True)
class Concept:
    """One tagging concept: text terms and an audio activation profile in 0..1."""

    terms: frozenset[str]
    profile: Callable[[dict[str, float]], float]


def _seed_of(concept_key: str) -> int:
    return int.from_bytes(hashlib.sha256(concept_key.encode("utf-8")).digest()[:8], "big")


def _unit_vector(key: str) -> F64:
    rng = np.random.default_rng(_seed_of(key))
    vector = rng.standard_normal(windows.DIM)
    return np.asarray(vector / np.linalg.norm(vector), dtype=np.float64)


def _clip(value: float) -> float:
    return float(min(1.0, max(0.0, value)))


def _features(mono: NDArray[np.floating], sample_rate: int) -> dict[str, float]:
    """Interpretable descriptors of one window (all bounded 0..1 except ``rms_db``)."""
    magnitude = stft_magnitude(mono, N_FFT, HOP)
    power = magnitude.astype(np.float64) ** 2
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sample_rate)
    frame_power = power.mean(axis=1)

    total = float(power.sum()) + 1e-12
    edges = [*_BAND_EDGES, sample_rate / 2.0]
    features: dict[str, float] = {}
    for index, name in enumerate(_BAND_NAMES):
        lo, hi = edges[index], edges[index + 1]
        mask = (freqs >= lo) & (freqs < hi) if index < len(_BAND_NAMES) - 1 else freqs >= lo
        features[name] = float(power[:, mask].sum()) / total

    if frame_power.size > 1:
        ratio = float(np.mean(np.abs(np.diff(frame_power)))) / (float(frame_power.mean()) + 1e-12)
    else:
        ratio = 0.0
    transient = _clip(ratio / (ratio + 0.5))
    features["transient"] = transient
    features["sustain"] = 1.0 - transient

    flat = np.exp(np.mean(np.log(power + 1e-12), axis=1)) / (power.mean(axis=1) + 1e-12)
    features["flat"] = _clip(float(np.mean(flat)))
    features["tone"] = 1.0 - features["flat"]
    centroid = float(np.mean(spectral_centroid_hz(magnitude, sample_rate, N_FFT)))
    features["centroid"] = _clip(centroid / (sample_rate / 2.0))
    features["high_end"] = features["highmid"] + features["high"] + features["air"]

    rms_db = 10.0 * np.log10(float(frame_power.mean()) * 2.0 + 1e-12)
    features["rms_db"] = max(-80.0, rms_db)
    features["rms"] = _clip((features["rms_db"] + 80.0) / 80.0)
    return features


#: The concept dictionary. Ids match the taxonomy ids where the concept is meant to score for a
#: category entry; concepts without an entry simply get activation 0 and never rank.
CONCEPTS: dict[str, Concept] = {
    # instruments
    "drums": Concept(
        frozenset({"drums", "drum", "percussion", "beat", "beats"}),
        (lambda f: f["transient"] * (0.4 + 0.6 * (f["lowmid"] + f["mid"] + f["high_end"]) * 2.0)),
    ),
    "bass": Concept(
        frozenset({"bass", "bassline", "basslines", "bass guitar", "bass music"}),
        (lambda f: (f["sub"] + f["bass"]) * (0.5 + 0.5 * f["sustain"]) * 2.0),
    ),
    "sub-bass": Concept(
        frozenset({"sub bass", "sub", "808", "subs"}),
        (lambda f: f["sub"] * 3.0),
    ),
    "kick-drum": Concept(
        frozenset({"kick", "kicks", "kick drum"}),
        (lambda f: (f["sub"] + f["bass"]) * f["transient"] * 4.0),
    ),
    "snare-drum": Concept(
        frozenset({"snare", "snares", "snare drum"}),
        (lambda f: (f["mid"] + f["highmid"]) * f["transient"] * 4.0),
    ),
    "hi-hat": Concept(
        frozenset({"hi hat", "hihat", "hats", "hat"}),
        (lambda f: (f["high"] + f["air"]) * f["transient"] * 5.0),
    ),
    "cymbals": Concept(
        frozenset({"cymbals", "cymbal", "crash", "ride"}),
        (lambda f: (f["high"] + f["air"]) * f["transient"] * 4.0),
    ),
    "drum-machine": Concept(
        frozenset({"drum machine", "909", "drum machines"}),
        (lambda f: f["transient"] * 0.8 + f["bass"] * 0.4),
    ),
    "percussion": Concept(
        frozenset({"congas", "bongos", "shaker", "tambourine", "hand claps", "percussive"}),
        (lambda f: (f["highmid"] + f["high"]) * f["transient"] * 4.0),
    ),
    "piano": Concept(
        frozenset({"piano", "keys", "grand piano"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 2.0 * (0.4 + 0.6 * f["sustain"])),
    ),
    "electric-piano": Concept(
        frozenset({"electric piano", "rhodes", "wurlitzer", "organ", "electric pianos"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 2.0 * (0.5 + 0.5 * f["sustain"])),
    ),
    "guitar": Concept(
        frozenset({"guitar", "guitars", "electric guitar", "acoustic guitar"}),
        (lambda f: f["tone"] * (f["mid"] + f["highmid"]) * 2.0 * (0.4 + 0.6 * f["sustain"])),
    ),
    "strings": Concept(
        frozenset({"strings", "violin", "cello", "viola", "string ensemble"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 2.0 * f["sustain"]),
    ),
    "synth": Concept(
        frozenset({"synth", "synths", "synthesizer", "synthesizers", "synthwave"}),
        (lambda f: f["tone"] * (f["mid"] + f["highmid"]) * 2.0 * f["sustain"]),
    ),
    "pad": Concept(
        frozenset({"pad", "pads"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 1.8 * f["sustain"]),
    ),
    "brass": Concept(
        frozenset({"brass", "trumpet", "saxophone", "sax", "horn", "trombone"}),
        (lambda f: f["tone"] * (f["highmid"] + f["mid"]) * 2.0 * (0.4 + 0.6 * f["sustain"])),
    ),
    "flute": Concept(
        frozenset({"flute", "piccolo", "recorder"}),
        (lambda f: f["tone"] * (f["high"] + f["highmid"]) * 3.0 * f["sustain"]),
    ),
    "vocals": Concept(
        frozenset({"vocals", "vocal", "voice", "singing", "singer", "vox"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 2.0 * (0.5 + 0.5 * f["sustain"])),
    ),
    "choir": Concept(
        frozenset({"choir", "choral", "chorus vocals"}),
        (lambda f: f["tone"] * f["mid"] * 2.5 * f["sustain"]),
    ),
    # broad genres
    "electronic": Concept(
        frozenset({"electronic", "electronica", "edm"}),
        (lambda f: f["tone"] * f["high_end"] * 1.5 + f["transient"] * 0.4),
    ),
    "house": Concept(
        frozenset({"house", "techno", "trance", "club", "clubby"}),
        (lambda f: f["transient"] * 0.7 + f["bass"] * 1.2 + f["tone"] * f["highmid"] * 0.8),
    ),
    "drum-and-bass": Concept(
        frozenset({"drum and bass", "dnb", "jungle", "breakbeat"}),
        (lambda f: f["transient"] * (f["sub"] + f["high"] + 0.2) * 2.0),
    ),
    "dubstep": Concept(
        frozenset({"dubstep", "bass drop"}),
        (lambda f: f["sub"] * 1.5 + f["transient"] * 0.5),
    ),
    "hip-hop": Concept(
        frozenset({"hip hop", "hiphop", "rap", "trap", "drill", "phonk"}),
        (lambda f: (f["sub"] + f["bass"]) * 1.5 + f["transient"] * 0.4),
    ),
    "rock": Concept(
        frozenset({"rock", "rock and roll", "punk"}),
        (lambda f: f["tone"] * (f["mid"] + f["highmid"]) * 1.5 * (0.4 + 0.6 * f["transient"])),
    ),
    "metal": Concept(
        frozenset({"metal", "metalcore", "djent"}),
        (lambda f: f["tone"] * f["highmid"] * 2.0 * (0.5 + 0.5 * f["transient"])),
    ),
    "pop": Concept(
        frozenset({"pop", "chart", "top 40"}),
        (lambda f: f["tone"] * f["mid"] * 1.5 * (0.5 + 0.5 * f["transient"])),
    ),
    "jazz": Concept(
        frozenset({"jazz", "swing", "bebop"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 1.5 * f["sustain"]),
    ),
    "classical": Concept(
        frozenset({"classical", "orchestra", "orchestral", "symphony", "baroque"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 1.4 * f["sustain"]),
    ),
    "ambient": Concept(
        frozenset({"ambient", "atmospheric", "drone", "ethereal"}),
        (
            lambda f: (
                f["tone"] * (f["lowmid"] + f["mid"]) * 1.5 * f["sustain"] * (1.0 - f["transient"])
            )
        ),
    ),
    "folk": Concept(
        frozenset({"folk", "acoustic", "americana", "singer songwriter"}),
        (lambda f: f["tone"] * f["mid"] * 1.6 * f["sustain"] * (1.0 - f["flat"] * 0.5)),
    ),
    "country": Concept(
        frozenset({"country", "bluegrass"}),
        (lambda f: f["tone"] * (f["mid"] + f["highmid"]) * 1.4 * f["sustain"]),
    ),
    "reggae": Concept(
        frozenset({"reggae", "dub", "ska", "dancehall"}),
        (lambda f: f["bass"] * 1.4 * (0.5 + 0.5 * f["sustain"]) + f["transient"] * 0.3),
    ),
    "blues": Concept(
        frozenset({"blues"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 1.4 * f["sustain"]),
    ),
    "soul": Concept(
        frozenset({"soul", "funk", "motown", "disco"}),
        (lambda f: f["bass"] * 0.6 + f["tone"] * f["mid"] * 0.6 + f["transient"] * 0.2),
    ),
    "world": Concept(
        frozenset({"world", "latin", "afrobeat", "samba", "flamenco"}),
        (lambda f: f["transient"] * (f["high_end"] + 0.3) + f["tone"] * f["mid"] * 0.5),
    ),
    "soundtrack": Concept(
        frozenset({"soundtrack", "score", "cinematic", "trailer", "musical theatre"}),
        (lambda f: f["tone"] * (f["lowmid"] + f["mid"]) * 1.4 * f["sustain"]),
    ),
    "sound-art": Concept(
        frozenset({"noise", "experimental", "avant garde"}),
        (lambda f: f["flat"] * 1.2),
    ),
    # moods
    "calm": Concept(
        frozenset({"calm", "relaxing", "relaxed", "chill", "peaceful", "serene", "mellow"}),
        (lambda f: (1.0 - f["transient"]) * f["tone"] * f["sustain"] * (1.0 - 0.6 * f["rms"])),
    ),
    "energetic": Concept(
        frozenset({"energetic", "upbeat", "driving", "powerful"}),
        (lambda f: f["transient"] * (0.3 + 0.7 * f["rms"])),
    ),
    "dark": Concept(
        frozenset({"dark", "moody", "brooding", "somber", "ominous", "eerie"}),
        (lambda f: (1.0 - f["centroid"]) * (0.4 + 0.6 * f["rms"])),
    ),
    "sad": Concept(
        frozenset({"sad", "melancholic", "melancholy", "mournful"}),
        (
            lambda f: (
                f["tone"] * (f["lowmid"] + f["mid"]) * 1.5 * f["sustain"] * (1.0 - f["centroid"])
            )
        ),
    ),
    "happy": Concept(
        frozenset({"happy", "joyful", "uplifting", "euphoric", "optimistic"}),
        (lambda f: f["tone"] * (f["mid"] + f["highmid"]) * 1.6 * (0.5 + 0.5 * f["transient"])),
    ),
    "epic": Concept(
        frozenset({"epic", "anthemic", "triumphant", "majestic"}),
        (lambda f: f["rms"] * (0.4 + 0.6 * f["tone"]) * f["sustain"]),
    ),
    "aggressive": Concept(
        frozenset({"aggressive", "angry", "intense", "harsh", "fierce"}),
        (lambda f: f["transient"] * (0.4 + 0.6 * f["rms"]) * 1.2),
    ),
    "groovy": Concept(
        frozenset({"groovy", "funky", "danceable", "bouncy", "syncopated"}),
        (lambda f: f["transient"] * (f["bass"] + f["lowmid"] + 0.2) * 2.0),
    ),
    "dreamy": Concept(
        frozenset({"dreamy", "hazy", "airy", "floating", "whimsical"}),
        (lambda f: f["tone"] * f["highmid"] * 2.0 * f["sustain"] * (1.0 - f["transient"])),
    ),
    "tense": Concept(
        frozenset({"tense", "anxious", "mysterious", "haunting"}),
        (lambda f: (1.0 - f["tone"]) * f["high_end"] + (1.0 - f["centroid"]) * 0.3),
    ),
    "romantic": Concept(
        frozenset({"romantic", "tender", "warm", "heartfelt"}),
        (lambda f: f["tone"] * f["lowmid"] * 2.5 * f["sustain"] * (1.0 - f["centroid"])),
    ),
    # descriptors
    "dusty": Concept(
        frozenset({"dusty", "lo fi", "lofi", "vintage", "retro"}),
        (lambda f: (1.0 - f["high_end"]) * 0.6 + f["flat"] * 0.4),
    ),
    "punchy": Concept(
        frozenset({"punchy", "snappy", "tight"}),
        (lambda f: f["transient"] * (f["sub"] + f["bass"] + f["mid"]) * 2.0),
    ),
    "sidechained": Concept(
        frozenset({"sidechained", "sidechain"}),
        (lambda f: f["transient"] * f["sub"] * 3.0),
    ),
    "distorted": Concept(
        frozenset({"distorted", "overdriven", "saturated", "gritty", "crunchy"}),
        (lambda f: f["flat"] * 0.7 + f["highmid"] * 0.8),
    ),
    "clean": Concept(
        frozenset({"clean", "crisp", "polished", "smooth"}),
        (lambda f: f["tone"] * (0.4 + 0.6 * f["high_end"] * 2.0)),
    ),
    "bright": Concept(
        frozenset({"bright", "shimmering", "sparkling", "glossy"}),
        (lambda f: f["centroid"] * 1.2),
    ),
    "dense": Concept(
        frozenset({"dense", "layered", "lush", "wall of sound", "maximalist"}),
        (lambda f: f["rms"] * (0.5 + 0.5 * f["flat"] * 2.0)),
    ),
    "sparse": Concept(
        frozenset({"sparse", "minimal", "stripped back"}),
        (lambda f: (1.0 - f["transient"]) * (1.0 - f["rms"]) * 0.8),
    ),
    "acoustic": Concept(
        frozenset({"organic", "live drums", "acoustic drums"}),
        (lambda f: f["tone"] * (1.0 - f["high_end"]) * (0.5 + 0.5 * f["sustain"])),
    ),
    "four-on-the-floor": Concept(
        frozenset({"four on the floor", "programmed drums", "trap drums"}),
        (lambda f: f["transient"] * f["sub"] * 4.0),
    ),
    "reverb-drenched": Concept(
        frozenset({"reverb drenched", "cavernous", "spacious", "wide"}),
        (lambda f: f["sustain"] * (1.0 - f["transient"]) * (0.5 + f["centroid"])),
    ),
}


#: A stable basis vector per concept id (see the module docstring).
_BASIS: dict[str, F64] = {cid: _unit_vector(cid) for cid in CONCEPTS}


def _grams(text: str) -> set[str]:
    words = "".join(c if c.isalnum() else " " for c in text.lower()).split()
    grams = set(words)
    grams.update(f"{a} {b}" for a, b in pairwise(words))
    return grams


class FallbackEmbedder:
    """The deterministic concept-basis embedder (see the module docstring)."""

    def __init__(self, dim: int = windows.DIM) -> None:
        """Fixes the vector length (the concept basis is defined only at 512)."""
        if dim != windows.DIM:
            raise ValueError(f"the concept basis is fixed at {windows.DIM} dimensions, got {dim}")
        self._dim = dim

    @property
    def model(self) -> str:
        """The model id recorded in the blob."""
        return FALLBACK_MODEL

    @property
    def dim(self) -> int:
        """The vector length."""
        return self._dim

    def _concepts(self, mono: NDArray[np.floating], sample_rate: int) -> F64:
        features = _features(mono, sample_rate)
        if features["rms_db"] <= SILENCE_RMS_DB:
            # Digital silence has no concept activation; the pool reports the degradation.
            return np.zeros(self._dim, dtype=np.float64)
        vector = np.zeros(self._dim, dtype=np.float64)
        for cid, concept in CONCEPTS.items():
            activation = _clip(concept.profile(features))
            if activation > 0.0:
                vector += activation * _BASIS[cid]
        return vector

    def window_vectors(self, mono: NDArray[np.floating], sample_rate: int) -> list[F64]:
        """One vector per 10 s/5 s window (04 §6.1), L2-normalised (all-zero for silence)."""
        duration = mono.shape[0] / sample_rate
        out: list[F64] = []
        for start, end in windows.window_spans(duration):
            lo = round(start * sample_rate)
            hi = min(round(end * sample_rate), mono.shape[0])
            if hi <= lo:
                out.append(np.zeros(self._dim, dtype=np.float64))
                continue
            raw = self._concepts(mono[lo:hi], sample_rate)
            # A silent window stays a zero vector so the pool can flag the degradation.
            out.append(
                windows.unit(raw)
                if float(np.linalg.norm(raw)) >= 1e-9
                else np.zeros(self._dim, dtype=np.float64)
            )
        return out

    def embed_texts(self, texts: Sequence[str]) -> F64:
        """The L2-normalised concept sum for each text's keywords (zero vector if none match)."""
        rows = np.zeros((len(texts), self._dim), dtype=np.float64)
        for index, text in enumerate(texts):
            grams = _grams(text)
            vector = np.zeros(self._dim, dtype=np.float64)
            for cid, concept in CONCEPTS.items():
                if concept.terms & grams:
                    vector += _BASIS[cid]
            rows[index] = windows.unit(vector) if np.linalg.norm(vector) >= 1e-9 else vector
        return rows


__all__ = ["CONCEPTS", "Concept", "FallbackEmbedder"]
