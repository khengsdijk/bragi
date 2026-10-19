# ADR-0013 — Bragi is a personal-use project

- **Status:** Accepted
- **Date:** 2026-10-19
- **Decider:** Koen
- **Open question:** Q6 (resolved)

## Context

Earlier drafts of the specs kept the door open to Bragi becoming a product. That shaped model and
dependency choices (candidates were filtered or rejected on non-technical grounds) and added
caveats, gates and open questions that agents kept stopping on.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Keep the option of a product | Preserves a path to launch | Narrows the candidate set, slows model and dependency choices, adds questions nobody needs answered |
| **Personal use only, never a product** | Choices are made on quality, cost and practicality; simpler specs; the best candidate wins the bake-off | No user-facing tiers, billing or multi-tenant concerns to design for |

## Decision

Bragi is a personal-use project and will never be a product. Dependencies, models and weights are
chosen on quality, cost and practicality only.

## Consequences

- Agents compare every model and library on its merits (quality, speed, size, operational
  simplicity). Do not raise non-technical concerns about a candidate, and do not add them to specs,
  ADRs, `MODELS.md` or work-package docs.
- Candidates that earlier ADRs held back for non-technical reasons are now plain candidates for the
  existing quality bake-offs. What is currently shipped does not change, and Proposed ADRs stay
  Proposed until their eval data or listening checks exist.
- `services/workers/MODELS.md` records pins, hashes, sources and versions, for reproducibility.
- Unchanged: no secrets and no copyrighted audio in the repo (it has a public remote); fixtures are
  self-made or generated and eval audio stays in a private bucket; the product behaviour rules in
  [10 §7](../10-fusion.md) (no imitating named artists, no voice cloning, provenance recorded) stay.
- No free or paid tiers; Q6 and Q7 are resolved in [15](../15-open-questions.md).
