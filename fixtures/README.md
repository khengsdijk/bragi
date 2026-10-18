# fixtures/

Test data. Everything here must be licence-clean: self-made, CC0 or generated, with a licence note
next to each file. **No copyrighted audio, ever** ([13 §1, §6](../specs/13-agent-guide.md)).

| Path | What it is | Budget |
|---|---|---|
| [`audio/`](audio) | Tiny audio clips for engine and analysis tests | ≤ 30 s each, ≤ 5 MB total in git |
| [`projects/`](projects) | Song documents for model and engine tests | — |
| [`eval/`](eval) | Manifest for the larger evaluation set, referenced by hash | audio is **never** committed |

**Status:** `projects/` holds the WP-0.2 song documents and root-type examples used by the
cross-language contract tests; `audio/` and `eval/` are placeholder directories, filled alongside
the work packages that need them — WP-0.4 and WP-1.1 (audio), WP-1.2 onwards (eval manifest).
