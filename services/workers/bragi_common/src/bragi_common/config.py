"""Worker configuration: environment variables validated at boot.

Every value has a working local default, so a worker starts with no ``.env`` at
all (``specs/01-architecture.md`` §8). No secret is ever committed.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven worker settings (``specs/05`` §1, ``specs/01`` §8)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgres://bragi:bragi@127.0.0.1:5432/bragi"
    nats_url: str = "nats://127.0.0.1:4222"

    s3_endpoint: str = "http://127.0.0.1:9000"
    s3_region: str = "us-east-1"
    s3_bucket: str = "bragi-blobs"
    s3_access_key_id: str = "bragi"
    s3_secret_access_key: str = "bragi-dev-secret"  # noqa: S105 - public local dev value
    s3_force_path_style: bool = True

    worker_name: str = "bragi-worker"
    scratch_dir: str = "/tmp/bragi-worker-scratch"  # noqa: S108 - local scratch only

    otel_enabled: bool = Field(default=True, validation_alias="OTEL_ENABLED")
    #: OTLP/HTTP collector base URL; the OTel spec's own environment variable
    #: name, so the exporters and the SDK agree on where spans go (05 §11).
    otel_endpoint: str = Field(
        default="http://127.0.0.1:4318",
        validation_alias="OTEL_EXPORTER_OTLP_ENDPOINT",
    )
    otel_service_name: str = Field(default="bragi-worker", validation_alias="OTEL_SERVICE_NAME")

    #: Minimum seconds between two ``progress`` events (05 §4.3: at most 2/s).
    progress_interval_s: float = 0.5
    #: Seconds between JetStream in-progress acks while a job runs (05 §4.3).
    in_progress_interval_s: float = 10.0
    #: How long SIGTERM waits for the running job before it gives up (05 §4.3).
    shutdown_grace_s: float = 30.0
    #: Retries the worker allows before it drops a failing message. The
    #: orchestrator owns the *official* retry count (05 §4.3); until it does,
    #: this keeps a broken capability from looping forever in local dev.
    max_attempts: int = 3
