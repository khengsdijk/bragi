# fixtures/eval

The evaluation set used by the analysis quality gates ([04](../../specs/04-analysis-pipeline.md),
[12](../../specs/12-roadmap.md)): beat F-measure, boundary hit-rate, chord and key accuracy, genre
agreement.

Only `manifest.json` and the small hand-label files under `labels/` live in git — the manifest
references audio **by hash**. The audio itself sits in a private bucket and is fetched by
`scripts/fetch-eval.sh` into `audio/` (gitignored; needs credentials). It is never committed
([13 §6](../../specs/13-agent-guide.md)).

**Status:** the format and the harness exist (WP-1.2); the **set itself does not**. `tracks` is
empty until the owner supplies roughly 50 labelled tracks, so every gate reports `PENDING` and no
eval number is produced or implied.

## `manifest.json`

```json
{
  "schemaVersion": 1,
  "description": "free text",
  "tracks": [
    {
      "id": "trk-001",
      "file": "trk-001.flac",
      "audioSha256": "<hex digest of the file in the bucket>",
      "source": "owner's library (optional, free text)",
      "genre": "house",
      "labels": { "beats": "labels/trk-001.beats", "sections": "labels/trk-001.sections" }
    }
  ]
}
```

- `file` is the name inside `fixtures/eval/audio/`. `audioSha256` is verified before a track is
  scored; a mismatch is reported as `hash_mismatch`, never scored.
- `labels.beats` is a text file, one beat per line: `<seconds>` or `<seconds> <position in bar>`
  (the `.beats` convention; a position of `1` marks a downbeat). `#` starts a comment.
- `labels.sections` is optional (WP-1.4) and a text file, one section per line:
  `<start> <end> <kind> [group]`, where `kind` is a `SectionKind` value and `group` is an optional
  repeat-letter. `#` starts a comment. Only tracks that carry this file count towards the structure
  gates (boundary hit-rate, label accuracy, chorus `repeatGroup`); `beats` remains required.
- Later stages add their own label files (chords, key, genre) as their work packages land.

## Running it

```bash
scripts/fetch-eval.sh      # needs BRAGI_EVAL_BUCKET + AWS credentials; fails clearly without them
pnpm eval:analysis         # writes reports/analysis-<date>.md
```

A gate is `PASS` or `FAIL` only when **every** manifest track was scored. Anything less — no
tracks, missing audio, a hash mismatch — is `PENDING`.
