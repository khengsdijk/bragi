# Model registry

The **mandatory** registry of every model the workers use ([04 §9](../../specs/04-analysis-pipeline.md),
[13 §4](../../specs/13-agent-guide.md)). Weights are never committed, are pinned here by SHA-256, are
fetched at image build time, and workers never download them at runtime. A model with a
non-commercial weights licence is flagged and needs replacing before any commercial launch (Q6 in
[15](../../specs/15-open-questions.md)).

## In use

| Name | Task | Version / checkpoint | SHA-256 | Code licence | Weights licence | Commercial use | Source | Verified |
|---|---|---|---|---|---|---|---|---|
| Beat This! `final0` | beats + downbeats (`analysis.rhythm`) | `beat-this` 1.1.0, checkpoint `final0.ckpt` (77.3 MB; trained on all data except GTZAN, seed 0) | `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331` | MIT | MIT | **yes**, with one caveat: the project's README notes that some training files are fully copyrighted or under limited Creative Commons licences, so a commercial launch should confirm it is comfortable with the training-data provenance (Q34) | code: <https://github.com/CPJKU/beat_this>; weights: <https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt> | 2026-10-19 |

The Beat This! loader (`bragi_analysis.trackers.beat_this`) refuses any checkpoint whose SHA-256
differs from the pin and reads it with `torch.load(weights_only=True)`. Set
`BRAGI_BEAT_THIS_CHECKPOINT` to the file; the worker `Dockerfile` does so for the `WITH_ML=1` build.

## Not models, but licensed components the stages depend on

| Component | Used by | Licence | Note |
|---|---|---|---|
| FFmpeg (`ffmpeg`, `ffprobe`) | `ingest`, `rhythm`, `loudness_energy` (decode) | LGPL-2.1+ / GPL-2+ depending on the build | Run as a **subprocess** of the worker, never linked. Use an LGPL build (the Debian `ffmpeg` package is GPL-enabled; fine for a server-side subprocess, but note it for any redistributed desktop sidecar, Q9) |
| Chromaprint (`fpcalc`) | `ingest` fingerprint | LGPL-2.1 | Subprocess, same reasoning |
| `mir_eval` | eval harness only | MIT | Not shipped in the worker image path that serves jobs |

## Evaluated and rejected

| Model | Why |
|---|---|
| madmom (RNN beat tracker + DBN) | Its pretrained models are distributed under CC BY-NC-SA 4.0 (non-commercial). Not re-verified in this WP because it is **not used**; Beat This! needs no DBN (`dbn=False`) |

## Planned (not yet in use)

Separation (WP-1.3), structure, harmony, embeddings and tagging models add their rows with their work
packages.
