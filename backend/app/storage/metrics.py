"""Prometheus metrics for the storage layer: the contract that dashboards and alerts are built on.

Do not rename metrics or labels without updating the Grafana dashboards and alert rules (P1).
All metrics live in the default ``prometheus_client`` registry, so the backend's ``/metrics`` endpoint
(P2: ``prometheus_client.make_asgi_app()``) exposes them with no extra wiring.

``filegrid_storage_operation_seconds`` (Histogram)
    Labels: ``storage`` (s3|ftp|db), ``operation`` (put|get|delete|health), ``category``,
    ``outcome`` (ok|error|rejected). Duration of one storage operation; for ``put``/``get`` it covers the
    whole stream (first byte to last byte). ``rejected`` = refused instantly because the circuit breaker
    is open. Buckets span 1 ms .. 300 s. Downloads that the consumer stops early are not observed.
    p95 per category and storage:
    ``histogram_quantile(0.95, sum by (le, category, storage) (rate(filegrid_storage_operation_seconds_bucket[5m])))``

``filegrid_storage_bytes_total`` (Counter)
    Labels: ``storage``, ``operation`` (put|get), ``category``. Bytes moved, incremented while streaming
    (so the throughput graph is smooth during a 1 GiB transfer). Throughput:
    ``sum by (storage, category) (rate(filegrid_storage_bytes_total[1m]))``

``filegrid_storage_errors_total`` (Counter)
    Labels: ``storage``, ``operation``, ``category``, ``error_type``. One increment per failed or rejected
    operation. ``error_type`` is ``CircuitOpen`` (rejected), ``IdleTimeout`` (no progress), ``Timeout``,
    ``ObjectNotFound``, ``IntegrityError``, ``SourceError`` (the caller's input stream failed, e.g. client
    disconnected mid-upload; not the storage's fault), ``HealthCheckFailed`` (operation ``health``) or the
    class name of the underlying error (e.g. ``ConnectionRefusedError``, ``EndpointConnectionError``).
    Health probes are recorded with ``category="system"``.
    Error rate: ``sum by (storage, category) (rate(filegrid_storage_errors_total[5m]))
    / sum by (storage, category) (rate(filegrid_storage_operation_seconds_count[5m]))``

``filegrid_storage_up`` (Gauge)
    Labels: ``storage``. 1 if the last health probe succeeded, else 0 (``HealthMonitor``, every 5 s).
    Alert "storage down": ``filegrid_storage_up == 0`` for 30 s.

``filegrid_storage_circuit_state`` (Gauge)
    Labels: ``storage``. 0 closed, 1 half-open, 2 open.

``category`` comes from the context variable ``current_category`` (default ``unknown``). P2 sets it per
request or job::

    from app.storage.metrics import use_category
    with use_category("fault_records"):
        await storage.put_stream(key, chunks)

A category is captured when the operation starts (``get_stream`` captures it when called, not when
iterated). Labels must match ``[a-z][a-z0-9_]{0,39}``; anything else is reported as ``invalid`` so a bad
value can never explode label cardinality.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Iterator
from contextvars import ContextVar

from prometheus_client import Counter, Gauge, Histogram

__all__ = [
    "BYTES_TOTAL",
    "CIRCUIT_STATE",
    "ERRORS_TOTAL",
    "OPERATION_SECONDS",
    "STORAGE_UP",
    "category_label",
    "current_category",
    "use_category",
]

current_category: ContextVar[str] = ContextVar("filegrid_storage_category", default="unknown")

_CATEGORY_RE = re.compile(r"[a-z][a-z0-9_]{0,39}")

BUCKETS = (
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
    1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0,
)

OPERATION_SECONDS = Histogram(
    "filegrid_storage_operation_seconds",
    "Duration of a storage operation (whole stream for put/get).",
    ["storage", "operation", "category", "outcome"],
    buckets=BUCKETS,
)
BYTES_TOTAL = Counter(
    "filegrid_storage_bytes_total",
    "Bytes written (put) or read (get) per storage and category.",
    ["storage", "operation", "category"],
)
ERRORS_TOTAL = Counter(
    "filegrid_storage_errors_total",
    "Failed or rejected storage operations.",
    ["storage", "operation", "category", "error_type"],
)
STORAGE_UP = Gauge(
    "filegrid_storage_up",
    "1 if the last health probe of the storage succeeded, else 0.",
    ["storage"],
)
CIRCUIT_STATE = Gauge(
    "filegrid_storage_circuit_state",
    "Circuit breaker state per storage: 0 closed, 1 half-open, 2 open.",
    ["storage"],
)


def category_label(value: str | None = None) -> str:
    """Return a safe ``category`` label: the given value or the current context's category."""
    value = current_category.get() if value is None else value
    return value if _CATEGORY_RE.fullmatch(value or "") else "invalid"


@contextlib.contextmanager
def use_category(category: str) -> Iterator[str]:
    """Set the metrics ``category`` for storage operations started inside the ``with`` block."""
    token = current_category.set(category)
    try:
        yield category_label(category)
    finally:
        current_category.reset(token)
