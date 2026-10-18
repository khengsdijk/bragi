# fixtures/eval

The evaluation set used by the analysis quality gates ([04](../../specs/04-analysis-pipeline.md),
[12](../../specs/12-roadmap.md)): beat F-measure, boundary hit-rate, chord and key accuracy, genre
agreement.

Only `manifest.json` lives in git — it references audio **by hash**. The audio itself sits in a
private bucket and is fetched by `scripts/fetch-eval.sh` (needs credentials). It is never committed
([13 §6](../../specs/13-agent-guide.md)).

**Status:** empty. The manifest and fetch script arrive with **WP-1.2**, the first WP with an eval
gate.
