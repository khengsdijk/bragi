# ADR-0004 — Separation model (part 1 of the model ADR) and the torch dependency

- **Status:** Proposed
- **Date:** 2026-10-19
- **Scope:** this is *part 1*: stem separation (WP-1.3). Generation models (Q4, WP-2.7) are added
  to this ADR later.

> **What this ADR is not.** The bake-off required by [04 §4, §8](../04-analysis-pipeline.md) runs on
> the owner's eval set, which does not exist yet. **No separation-quality number (SDR) is
> claimed here.** The decision below is a *provisional default* chosen on availability,
> speed and operational simplicity, and it stays Proposed until the eval-set bake-off (procedure at
> the end) has been run. Reference-GPU timing is likewise unmeasured.

## Context

04 §4 names HTDemucs 6-source (`htdemucs_6s`) as the v1 default and a RoFormer family as a possible
vocal-quality upgrade. The worker needs a model, a way to run it on CPU (13 §3), pinned weights
(04 §9) and a new major dependency (torch), which AGENTS.md says needs an ADR.

## Options considered

Measured on an Apple M2 Pro (32 GB), torch 2.14.1, one generated 4-minute 48 kHz stereo signal
(kick/hat/bass/chords/tone: **not music**, so only speed and memory are meaningful). Separation
only = model + stitching; "capability total" = the whole `analysis.separation` run including FLAC
decode/encode and resampling. Single runs, not averaged; the first MPS figure of 44 s was taken
while other work was running on the machine and is not representative.

| Option | Size | 4 min, MPS | 4 min, CPU | Peak RSS | Notes |
|---|---|---|---|---|---|
| **`htdemucs_6s`** | 27.4 M params, 52 MiB | 22.0 and 24.5 s separation (2 runs); **29.9 s capability total** | 107.5 s separation; **79.5 s capability total** | 3.8 to 4.2 GiB (MPS), 4.5 GiB (CPU) | 6 stems; upstream: piano/guitar are weak |
| `htdemucs` (4 stems) | 42.0 M params, 80 MiB | 23.7 s | 108.6 s | 3.3 GiB / 4.0 GiB | no guitar/piano stems; same cost as 6s |
| `htdemucs_ft` (bag of 4) | 4 x 80 MiB | 90.9 s | not run | 4.1 GiB | ~4x compute; claims a small SDR gain upstream, unverified here |
| Mel-Band RoFormer (vocals), `KimberleyJSN/melbandroformer` | 240 M params, 913 MB | 256.7 s for 34 chunks of 8 s, **random weights** | not run | n/a | **The checkpoint did not load** into `bs-roformer` 1.2.4 (498 missing / 120 unexpected keys, version drift), so only the architecture was timed. Vocals/instrumental only. ~10x slower than HTDemucs on MPS |

What the numbers do and do not say:

- All three Demucs variants produce plausible, non-silent drums/bass/other energy on the synthetic
  signal. That is a plumbing check, not a quality measure, and no SDR is reported.
- `htdemucs_6s` costs the same as the 4-stem model, so the extra two stems are free in time.
- On the **reference GPU (L4/A10 class) nothing was measured.** The acceptance target (< 40 s for a
  4-min song) is met by the capability on this laptop's MPS (29.9 s total) but that is not the
  reference hardware, so the criterion is recorded as *unmeasured*, not passed.
- Not evaluated: other RoFormer/BS-RoFormer checkpoints, a vocal-then-Demucs cascade, drum
  sub-separation models, MDX-family models.

## Decision (provisional)

1. **Adopt `htdemucs_6s` as the v1 separation default**, as 04 §4 already assumes, with `htdemucs`
   as a configured fallback. Weights are pinned by revision and SHA-256 in
   `analysis/src/bragi_analysis/separation/models_lock.json` and fetched at image build.
2. **Depend on `torch` and `demucs`** (4.1.0), in a non-default uv dependency group
   (`models`) so `pnpm verify` stays light and CPU-only. Use `demucs` for the network
   definition only; chunking, crossfade, resampling, residual and silent-stem logic are Bragi's own
   (`separation/pipeline.py`) so they are testable without a model and independent of Demucs' own
   `apply_model` splitting.
3. **Pipeline choices** (all in `docs/wp/1.3.md`): resample the whole song once to 44.1 kHz and back;
   chunk length is `min(10 s, model limit)`, which is 7.8 s for HTDemucs because its transformer
   rejects longer inputs; residual = mix minus the **stored** (24-bit decoded) kept stems, so the
   null is exact (measured: bit-exact, `-inf` dBFS, on the real model and on the stub).
4. **Do not adopt a RoFormer vocal model yet.** It is the likely quality upgrade for vocals, but it
   is ~10x slower here, its checkpoint did not load with the current library, and quality cannot
   be compared without the eval set.
5. **Intel macOS is not a supported worker platform** (`tool.uv.environments`): demucs pins
   `torch<2.3` and `numpy<2` there, which would hold every other platform back.

## Consequences

Positive: small weights, CPU fallback at 0.33x real time, CUDA/MPS/CPU
selected automatically, weights verified before load, no runtime network access.

Negative / risks:

- `lameenc` comes in through `demucs` although it is never called. Options: keep it, or vendor
  only the network code.
- Any better separation model (including those previously held back) is a candidate for the
  bake-off below; the stage version string lets old projects keep their stems.
- `piano` and `guitar` stems are weak upstream; the UI should not promise more than "experimental".
- The linux torch wheel bundles CUDA, so the image is large; a CPU-only image would need a torch
  index override.
- The Docker image build with `--group models` and the weight fetch were **not run** (Docker Hub is
  blocked in the development sandbox); the fetch logic is unit-tested for hash refusal, and
  `python -m bragi_analysis.separation.weights` was run for real against Hugging Face into a scratch
  directory (all four pinned files fetched and hash-verified).

## To make this Accepted (eval-set bake-off, owner's set)

1. On `fixtures/eval/` (WP-1.2's manifest and fetch script), run `htdemucs_6s`, `htdemucs`,
   `htdemucs_ft` and at least one loading RoFormer vocal checkpoint through the same pipeline.
2. Report per-stem SDR where multitracks exist (04 §8 says "report only") plus a blind listening
   pass on vocals and drums for the rest, and the time per 4-min song on the reference GPU.
3. Update this ADR with the numbers, set Accepted, and bump `stageVersion` if the model changes.
