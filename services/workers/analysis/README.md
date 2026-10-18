# bragi-analysis

The analysis workers — how a dropped file becomes a song you can see
([04-analysis-pipeline.md](../../../specs/04-analysis-pipeline.md)).

| Capability | Produces | Filled by | Quality gate |
|---|---|---|---|
| `ingest` | 48 kHz 24-bit FLAC working copy, fingerprint, rejects | WP-1.2 | correct error codes for corrupt/too-long input |
| `rhythm` | beats, downbeats, tempo map | WP-1.2 | beat F ≥ 0.85 |
| `loudness_energy` | energy curve, loudness | WP-1.2 | documented hop and range |
| `separate` | stems + residual | WP-1.3 | Σ stems + residual nulls ≤ −60 dBFS; 4 min < 40 s on the reference GPU |
| `structure` | sections, repeat groups | WP-1.4 | boundary hit-rate ≥ 0.70, label accuracy ≥ 0.60 |
| `harmony` | key, chords, progression fingerprint | WP-1.5 | chords ≥ 0.70, key ≥ 0.80, key-invariant fingerprint |
| `tag`, `describe` | taxonomy tags, plain-language description | WP-1.6, WP-1.7 | top-3 genre ≥ 0.70; 0 hard failures, grounding post-check |
| `drum_split`, `transcribe`, `lyrics` | deep profile | WP-6.2 (transcribe may land in WP-4.3) | — |

**Status:** scaffold.
