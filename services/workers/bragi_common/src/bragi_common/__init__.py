"""Shared framework for every Bragi worker.

Provides the parts that no capability should reimplement: the NATS JetStream
client and job protocol, the result cache, S3 input/output, progress reporting,
cancellation and the Pydantic v2 models generated from
``packages/schemas`` (``specs/05-backend-and-jobs.md``).

A worker capability is a module exposing ``CAPABILITY``, ``ParamsModel`` and
``run(job, ctx) -> Outputs``; this framework handles everything else
(``specs/13-agent-guide.md`` §3). It is held to ``mypy --strict``.

Status:
    Scaffold (WP-0.1). Built by **WP-0.7**, together with an ``echo``
    capability and OpenTelemetry tracing from API through NATS to worker.
"""
