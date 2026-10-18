# bragi-common

The worker framework. Everything a capability should not have to reimplement: the NATS JetStream
client and job protocol, the result cache, S3 input/output, progress reporting, cancellation, and
the Pydantic v2 models generated from [`packages/schemas`](../../../packages/schemas)
([05-backend-and-jobs.md](../../../specs/05-backend-and-jobs.md)).

Held to `mypy --strict` without exception ([13 §3](../../../specs/13-agent-guide.md)).

**Status:** scaffold. Built by **WP-0.7**, whose acceptance is an integration test that logs in,
uploads a file, submits an `echo` job, receives `progress` and `completed` over WebSocket, and
produces one trace spanning API → NATS → worker.
