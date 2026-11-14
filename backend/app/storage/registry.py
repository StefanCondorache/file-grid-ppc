"""Builds the three FileGrid storages from environment variables and wires resilience around them.

Storage names (the values P2's policy table uses for primary/fallback storage): ``s3``, ``ftp``, ``db``.
Environment variables: see ``config.py``.

Usage in the FastAPI app (P2)::

    from contextlib import asynccontextmanager
    from app.storage.registry import StorageRegistry
    from app.storage.metrics import use_category

    @asynccontextmanager
    async def lifespan(app):
        app.state.storages = StorageRegistry.from_env()
        await app.state.storages.start()      # DB schema (best effort) + background health monitor
        yield
        await app.state.storages.aclose()

    storage = app.state.storages.get(policy.primary_storage)   # a ResilientStorage
    with use_category("fault_records"):
        size, sha256 = await storage.put_stream(key, chunks)

    try:
        ...
    except StorageUnavailable:   # down, timed out, or circuit open (fails in microseconds)
        storage = app.state.storages.get(policy.fallback_storage)

``registry.status()`` returns the last health probe and breaker state per storage (for ``/api/health``
or the demo panel).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

from .base import StorageAdapter
from .config import DbSettings, FtpSettings, ResilienceSettings, S3Settings, StorageSettings
from .db import DbStorage
from .ftp import FtpStorage
from .resilience import CircuitBreaker, HealthMonitor, ResilientStorage
from .s3 import S3Storage

__all__ = ["STORAGE_NAMES", "StorageRegistry", "build_adapter"]

log = logging.getLogger("filegrid.storage.registry")

STORAGE_NAMES = ("s3", "ftp", "db")


def build_adapter(name: str, env: Mapping[str, str] = os.environ) -> StorageAdapter:
    """Build one raw adapter (no breaker/metrics) from the environment."""
    if name == "s3":
        return S3Storage(S3Settings.from_env(env))
    if name == "ftp":
        return FtpStorage(FtpSettings.from_env(env))
    if name == "db":
        return DbStorage(DbSettings.from_env(env))
    raise ValueError(f"unknown storage {name!r}; expected one of {STORAGE_NAMES}")


class StorageRegistry:
    def __init__(self, storages: Mapping[str, ResilientStorage], resilience: ResilienceSettings | None = None):
        self.resilience = resilience or ResilienceSettings()
        self._storages = dict(storages)
        self.monitor = HealthMonitor(
            self._storages.values(), interval=self.resilience.health_interval_s
        )

    @classmethod
    def from_adapters(
        cls, adapters: Mapping[str, StorageAdapter] | list[StorageAdapter], resilience: ResilienceSettings | None = None
    ) -> StorageRegistry:
        resilience = resilience or ResilienceSettings()
        items = adapters.values() if isinstance(adapters, Mapping) else adapters
        storages = {
            a.name: ResilientStorage(
                a,
                CircuitBreaker(a.name, resilience.breaker_failures, resilience.breaker_reset_s),
                idle_timeout=resilience.idle_timeout_s,
                op_timeout=resilience.op_timeout_s,
                health_timeout=resilience.health_timeout_s,
            )
            for a in items
        }
        return cls(storages, resilience)

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> StorageRegistry:
        settings = StorageSettings.from_env(env)
        adapters = [S3Storage(settings.s3), FtpStorage(settings.ftp), DbStorage(settings.db)]
        return cls.from_adapters(adapters, settings.resilience)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._storages)

    def get(self, name: str) -> ResilientStorage:
        try:
            return self._storages[name]
        except KeyError:
            raise ValueError(f"unknown storage {name!r}; configured: {', '.join(self._storages)}") from None

    __getitem__ = get

    def __iter__(self):
        return iter(self._storages.values())

    async def start(self, *, monitor: bool = True) -> None:
        """Create the DB schema (best effort: a DB that is down must not stop the app) and start health polling."""
        db = self._storages.get("db")
        if db is not None and isinstance(db.adapter, DbStorage):
            try:
                await db.adapter.ensure_schema()
            except Exception as exc:  # noqa: BLE001 - retried lazily on first DB use
                log.warning("storage db: schema not ensured at startup (%s); will retry on first use", exc)
        if monitor:
            await self.monitor.check_once()
            self.monitor.start()

    def status(self) -> dict[str, dict]:
        out = {}
        for name, s in self._storages.items():
            h = s.last_health
            out[name] = {
                "up": None if h is None else h.ok,
                "latency_ms": None if h is None else round(h.latency_ms, 2),
                "detail": None if h is None else h.detail,
                "circuit": s.breaker.state.name.lower(),
            }
        return out

    async def aclose(self) -> None:
        await self.monitor.stop()
        for s in self._storages.values():
            try:
                await s.aclose()
            except Exception as exc:  # noqa: BLE001
                log.warning("storage %s: close failed: %s", s.name, type(exc).__name__)
