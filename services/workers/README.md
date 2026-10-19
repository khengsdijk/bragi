# services/workers

The Python side: a **uv workspace** of ML workers that pull jobs from NATS JetStream, read and
write S3 blobs, and report progress back to the API
([05-backend-and-jobs.md](../../specs/05-backend-and-jobs.md)).

| Member | Distribution | What it does | Filled by |
|---|---|---|---|
| [`bragi_common/`](bragi_common) | `bragi-common` | Worker framework: NATS client, job protocol, result cache, S3 IO, progress, cancel, generated Pydantic models | WP-0.7 (**done**) |
| [`analysis/`](analysis) | `bragi-analysis` | ingest, separate, rhythm, loudness_energy, structure, harmony, tag, describe | WP-1.2 (`ingest`, `rhythm`, `loudness_energy`: **done**), WP-1.4 (`structure`: **done**; gates pending the eval set) → WP-1.7; also ships the `echo` test capability |
| [`embed/`](embed) | `bragi-embed` | audio/text embeddings, tag heads, projection, constellations | WP-1.6, WP-3.2 |
| [`generate/`](generate) | `bragi-generate` | extend, inpaint, stem-gen, text2music, fx, transform | WP-2.7+ |

`python -m bragi_analysis` runs the analysis worker (`echo`, `analysis.ingest`, `analysis.rhythm`,
`analysis.loudness_energy`, `analysis.structure`), and the CPU `worker` service in
`infra/docker-compose.yml` runs the same command.

## Conventions ([13 §3](../../specs/13-agent-guide.md))

- **Python 3.12**, managed by `uv`. `.python-version` pins it, so the system interpreter is never
  used.
- `ruff` + `mypy --strict`. `bragi_common` stays strict; model-heavy worker code may be relaxed per
  package.
- **A capability is a module exposing `CAPABILITY`, `ParamsModel` and `run(job, ctx) -> Outputs`.**
  The framework handles pulling, caching, IO, progress and cancellation.
- **GPU code must also run on CPU** (slowly), so CI can run tiny smoke tests.
- Model weights are pinned by hash in `MODELS.md` and downloaded at image build — never committed.
- Structured logging, and never audio content, lyrics or prompts at info level.

## Commands

```bash
uv sync --directory services/workers   # create .venv and install every member
pnpm lint:py                           # ruff check + ruff format --check + mypy
pnpm test:py                           # pytest
```
