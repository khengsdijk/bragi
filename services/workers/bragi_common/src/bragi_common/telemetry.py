"""OpenTelemetry for workers (``specs/05`` §11).

The worker's ``jobs.consume`` span is created as a **child of the API's
``jobs.publish`` span**, using the W3C ``traceparent`` carried in the
``JobRequest`` (05 §4.2). That single link is what makes one trace span
API → NATS → worker.
"""

from __future__ import annotations

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagate import extract
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from bragi_common.config import Settings

_provider: TracerProvider | None = None


def setup_telemetry(settings: Settings) -> trace.Tracer:
    """Installs the tracer provider once and returns a tracer."""
    global _provider
    if _provider is None:
        resource = Resource.create({"service.name": settings.otel_service_name})
        provider = TracerProvider(resource=resource)
        if settings.otel_enabled:
            provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=f"{settings.otel_endpoint.rstrip('/')}/v1/traces")
                )
            )
        _provider = provider
    return _provider.get_tracer(settings.otel_service_name)


def shutdown_telemetry() -> None:
    """Flushes and shuts the provider down, if one was installed."""
    global _provider
    if _provider is not None:
        _provider.shutdown()
        _provider = None


def context_from_traceparent(traceparent: str) -> otel_context.Context:
    """Extracts a remote span context from a W3C ``traceparent``."""
    return extract({"traceparent": traceparent})
