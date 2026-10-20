# Planner bench

The offline/online evaluation harness for the AI planner ([06 §9](../../../../specs/06-ai-planner.md)).
It runs the real planner over synthetic fixture projects and checks **structural expectations** on
the returned `EditPlan`: which ops it used, which tracks and ticks it touched, whether the variants
differ, whether it asked a clarification, and whether it obeyed the content policy.

The metrics are the four in 06 §9:

| Metric | Target | What it means |
|---|---|---|
| Valid plan rate | ≥ 98 % | A plan or a clarification came back, not `PLAN_INVALID`. |
| Expectation pass rate | ≥ 85 % | Every configured expectation for the case passed. |
| Latency P50 / P95 | < 2.5 s / < 6 s | Wall time of one `POST /v1/plans` (all calls, including repair). |
| Over-reach | 0 | A returned variant changed ticks or tracks outside its region without `scope: "song"`. Re-checked from the canonical document diff; a non-zero value fails the run. |

The harness also reports the number of model calls (a repair round is a second call), dropped
variants, token usage and cost when OpenRouter returns `usage` (the client requests
`usage: { include: true }`).

## Running

```sh
pnpm bench:planner                     # all cases, live (needs OPENROUTER_API_KEY)
pnpm bench:planner --cases fx-*        # one family
pnpm bench:planner --tier fast         # only cases the classifier puts in the fast tier
pnpm bench:planner --repeat 3          # run every selected case three times
pnpm bench:planner --record            # live run, writes recordings/replies.json
pnpm bench:planner --dry               # replay the recordings, no key or network
```

| Option | Default | Meaning |
|---|---|---|
| `--model <slug>` | config | Overrides **every** tier for this run; never edits `config/planner.toml`. |
| `--tier fast\|smart` | all | Keeps only cases whose classifier tier matches. |
| `--cases <ids\|glob>` | all | Comma-separated IDs or `*` globs (`fx-*`, `policy-*`, `mix-mute-texture`). |
| `--concurrency <n>` | 4 | Cases in flight, 1–32. |
| `--repeat <n>` | 1 | Repetitions per case, 1–10. |
| `--dry` | off | Replays `recordings/replies.json`; missing recordings are skipped. |
| `--record` | off | Stores every reply for `--dry` (replies only; no headers, key or prompt). |

Live runs load `.env` and `infra/.env` exactly like `pnpm dev:backend`: the root file first, then
`infra/.env`, shell values win, empty values are skipped. `--dry` needs no key.

Reports are written to `bench-results/planner-<timestamp>-<model>.json` (git-ignored). The report
holds the returned plan, expectation checks, per-call latency and usage, dropped labels, invalid
reasons and the raw last reply for invalid runs.

## Fixtures and cases

`fixtures/*.json` are complete `Project` documents that pass `validateProject`. They are original,
synthetic arrangements with invented names; no audio and no copyrighted material:

| Fixture | Shape |
|---|---|
| `night-shift.json` | 6 tracks, 8 sections (80 bars), a locked Bridge, one source and an analysis summary. |
| `paper-lanterns.json` | 3 tracks, 4 sections, no analysis (the sparse case). |
| `hostile-names.json` | The sparse song with prompt-injection text in a track name and a section label. |

`cases.json` has 43 ops-only cases. Regions are absolute ticks and section-aligned, because the
validator attributes a lane change to its whole section span. The families are:

- **fx/macro in a region** (`fx-*`): warmer, brighter, more space, punchier, quieter, filter sweep,
  lo-fi, a macro, and the same on the sparse fixture. These expect `onlyOpKinds`, the selected
  track(s), `insideRegion`, `timeLimited` and `minVariants`.
- **whole song** (`song-*`): `scope: "song"` is allowed, including one sparse fixture.
- **arrangement** (`arr-*`): remove, duplicate, move, rename, loop/extend, shorten, merge.
- **mixer** (`mix-*`): mute, solo, gain on one track.
- **locked section** (`locked-*`): a region containing the locked Bridge; `noTouch` must hold.
- **ambiguous** (`ambiguous-*`): three directionless prompts that must ask a clarification.
- **plain language** (`plain-*`): muddy chorus, buried words, too busy, dreamier outro, "turn this
  down".
- **prompt injection** (`inject-*`): instructions in the prompt, a track name and a section label.
- **content policy** (`policy-*`): five prompts from `policy-prompts.json`; each expects a
  "described" notice and no artist name in the plan body (the notice itself names what it
  described).

## Expectation keys

All checks live in `expectations.ts`; they read the plan and the fixture only, so the unit tests
run offline on hand-written plans.

| Key | Passes when |
|---|---|
| `minVariants` / `maxVariants` | The plan has that many variants. |
| `onlyOpKinds` / `forbiddenOpKinds` | Every op name is allowed / none is forbidden. |
| `touchesOnlyTracks` | No variant targets a track outside the list. |
| `insideRegion` | Every non-`scope: "song"` variant stays inside the request's region. |
| `timeLimited` | No bare track/master fx or mixer change: a track lever needs lane automation that confines it (or the variant is `scope: "song"`). |
| `distinctLeverTypes` | At least N of fx, automation, mixer, clip, arrangement, song appear across variants. |
| `asksClarification` | The plan has a clarification. |
| `scopeSong` | At least one variant declares `scope: "song"`. |
| `noTouch` | None of these track/section IDs appears in any op. |
| `noticeContains` | Every string appears in a notice. |
| `forbiddenText` | None appears in the interpretation, clarification or variants (notices excluded). |
| `containsText` | Every string appears in the interpretation or variants. |
| `interpretationExcludesDropped` | When validation dropped a variant, the interpretation neither names it nor talks about "options"/"variants". |

## Offline smoke test

`pnpm --filter @bragi/api test` runs `run.test.ts`, which replays three recorded cases
(`arr-remove-section`, `mix-mute-texture`, `policy-jackson`) with `--dry` and asserts that they are
valid, pass their expectations and have zero over-reach. The smoke test never touches the network.
