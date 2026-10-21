# ADR-0015 — Generation models: ACE-Step 1.5 for extend

- **Status:** Accepted (check 4 of 09 §9 still to be measured on the reference GPU)
- **Date:** 2026-10-21
- **Decider:** Koen
- **Work package:** WP-2.7 (answers Q4; ADR-0004 is the separation ADR, so the roadmap's "→ ADR-0004"
  for generation points here)

## Context

09 §3 lists model families per capability and asks for a bake-off before committing. WP-2.7 builds
`generate.extend`, the first generative capability, and the infrastructure every later one reuses
(the `GenerationBackend` adapter, the routing table, the quality gates). Bragi is a personal-use
project ([ADR-0013](ADR-0013-personal-use-only.md)) developed on an M2 Pro (32 GB); renting a GPU is
possible but needs the owner's go-ahead.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **ACE-Step 1.5 (open weights)** | Full-song model with repaint/extend editing (extend, later inpaint and variation in WP-2.8 from one model); runs locally on MPS; REST API of its own | ~20 GB peak on the Mac; MPS output is not bit-reproducible per seed |
| MusicGen-class | Simple continuation, melody conditioning | No native infill; weaker long-form structure |
| Stable Audio Open-class | Good short SFX/ambience | Not built for song continuation (kept for `generate.fx`) |
| Hosted music APIs | Strong quality, no local GPU | Network dependency, per-call cost, audio-input conditioning not always offered |

## Decision

- **ACE-Step 1.5 (turbo) serves `generate.extend` on both tiers** (`config/generation_routes.yaml`:
  preview 4 steps, HQ 8 steps). It runs as its **own process** with its own uv environment
  (`scripts/ace-step-setup.sh` pins the checkout; weights in `.bragi/models/ace-step`, 9.4 GB), and the
  worker talks to its REST API on `127.0.0.1:8001`. Its torch/transformers pins stay out of the
  workspace, and a hosted backend later has the same shape.
- **PyTorch/MPS is the default engine on Apple Silicon** (`BRAGI_ACE_STEP_ENGINE=mlx|pytorch`):
  measured 27.7 s vs 35.5 s P50 for a 30 s extend and 22 GB vs 36 GB peak (M2 Pro, not the reference
  GPU).
- **A deterministic fake backend** (`BRAGI_GENERATION_BACKEND=fake`) serves tests and the live e2e.
- Models stay swappable through the routing table; the capability contracts (09 §2) do not change.

## Consequences

- 09 §9 check 1 passes on the five synthetic bench songs (docs/wp/2.7.md "Generation bench"); the
  owner's blind seam listening is pending (`docs/wp/2.7-MANUAL_CHECKS.md`).
- **Check 4 (first preview ≤ 15 s P50 on a warm GPU) is not met on the Mac** (≈ 23 s) and needs the
  reference GPU; renting one waits for the owner.
- Same-seed HQ re-renders are a repeat, not a copy, on MPS.
- Backward extends (intros) prepend silence and repaint the start; a negative repaint start
  regenerated the whole clip in the spike.
