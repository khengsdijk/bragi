"""The harmony stage (``specs/04`` §5.3): key, chords and the progression fingerprint.

Pure numeric core, no I/O and no model weights:

- :mod:`bragi_analysis.harmony.chroma` — pitch-class chroma and beat synchronisation
- :mod:`bragi_analysis.harmony.chords` — templates, the Viterbi decoder, the recognizer seam
- :mod:`bragi_analysis.harmony.key` — key estimation, roman numerals, the fingerprint
- :mod:`bragi_analysis.harmony.pipeline` — the ``HarmonyResult`` builder

The capability lives in :mod:`bragi_analysis.capabilities.harmony` and wires the
framework (assets, scratch, upload) to :func:`pipeline.build_result`.
"""
