"""Storage settings read from environment variables (12-factor; the same code runs on laptops and in k3s).

Defaults match the laptop stack from ``make infra-up`` (Docker Compose, ports bound to 127.0.0.1).
Credentials have no defaults: on a laptop export them from ``infra/.env``; in k3s the Deployment/Job
uses ``envFrom: secretRef: filegrid-storage-credentials``.

S3 (SeaweedFS, path-style addressing)
    FILEGRID_S3_ENDPOINT        default ``http://127.0.0.1:9000``
                                (k3s: ``http://s3.filegrid-storage.svc.cluster.local:8333``)
    S3_ACCESS_KEY, S3_SECRET_KEY required
    S3_BUCKET                   default ``filegrid``
    FILEGRID_S3_REGION          default ``us-east-1``
    FILEGRID_S3_PART_SIZE       multipart part size in bytes, default 8 MiB (min 5 MiB)
    FILEGRID_S3_MAX_POOL        max HTTP connections, default 16

FTP (pure-ftpd, passive mode: EPSV, then PASV)
    FILEGRID_FTP_HOST           default ``127.0.0.1`` (k3s: ``ftp.filegrid-storage.svc.cluster.local``)
    FILEGRID_FTP_PORT           default 21
    FTP_USER, FTP_PASSWORD      required
    FILEGRID_FTP_MAX_CONNECTIONS max concurrent control connections per process, default 4. pure-ftpd in
                                ``infra/`` and ``deploy/`` runs with the image defaults ``-c 5 -C 5`` (5 clients
                                in total, 5 per IP), so keep this below 5 per process.

PostgreSQL (asyncpg; objects live in schema ``blobstore``)
    FILEGRID_PG_DSN             full DSN; if unset it is built from the variables below
    FILEGRID_PG_HOST            default ``127.0.0.1`` (k3s: ``postgres.filegrid-storage.svc.cluster.local``)
    FILEGRID_PG_PORT            default 5432
    POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB  required when FILEGRID_PG_DSN is unset
    FILEGRID_PG_POOL_MAX        default 8
    FILEGRID_PG_CHUNK_SIZE      bytes per stored row, default 1 MiB

Resilience (see ``resilience.py``)
    FILEGRID_STORAGE_BREAKER_FAILURES   consecutive failures that open a breaker, default 5
    FILEGRID_STORAGE_BREAKER_RESET_S    seconds before an open breaker allows one trial call, default 10
    FILEGRID_STORAGE_HEALTH_INTERVAL_S  health poll period, default 5
    FILEGRID_STORAGE_HEALTH_TIMEOUT_S   timeout of one health probe, default 2
    FILEGRID_STORAGE_IDLE_TIMEOUT_S     max seconds without progress on a streaming op, default 30
    FILEGRID_STORAGE_OP_TIMEOUT_S       total timeout of delete, default 10
    FILEGRID_STORAGE_CONNECT_TIMEOUT_S  TCP connect timeout used by the adapters, default 3
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import quote

__all__ = ["ConfigError", "DbSettings", "FtpSettings", "ResilienceSettings", "S3Settings", "StorageSettings"]

MiB = 1024 * 1024


class ConfigError(ValueError):
    """A required storage setting is missing or invalid (the message never contains secret values)."""


def _req(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "")
    if not value:
        raise ConfigError(f"environment variable {name} is required")
    return value


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, "")
    try:
        return int(raw) if raw else default
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None


def _float(env: Mapping[str, str], name: str, default: float) -> float:
    raw = env.get(name, "")
    try:
        return float(raw) if raw else default
    except ValueError:
        raise ConfigError(f"{name} must be a number") from None


@dataclass(frozen=True)
class S3Settings:
    endpoint: str
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)
    bucket: str = "filegrid"
    region: str = "us-east-1"
    part_size: int = 8 * MiB
    max_pool: int = 16
    connect_timeout: float = 3.0
    read_timeout: float = 30.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> S3Settings:
        part = _int(env, "FILEGRID_S3_PART_SIZE", 8 * MiB)
        if part < 5 * MiB:
            raise ConfigError("FILEGRID_S3_PART_SIZE must be at least 5 MiB (S3 multipart minimum)")
        return cls(
            endpoint=env.get("FILEGRID_S3_ENDPOINT") or "http://127.0.0.1:9000",
            access_key=_req(env, "S3_ACCESS_KEY"),
            secret_key=_req(env, "S3_SECRET_KEY"),
            bucket=env.get("S3_BUCKET") or "filegrid",
            region=env.get("FILEGRID_S3_REGION") or "us-east-1",
            part_size=part,
            max_pool=_int(env, "FILEGRID_S3_MAX_POOL", 16),
            connect_timeout=_float(env, "FILEGRID_STORAGE_CONNECT_TIMEOUT_S", 3.0),
        )


@dataclass(frozen=True)
class FtpSettings:
    host: str
    port: int = 21
    user: str = field(default="", repr=False)
    password: str = field(default="", repr=False)
    max_connections: int = 4
    connect_timeout: float = 3.0
    socket_timeout: float = 30.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> FtpSettings:
        return cls(
            host=env.get("FILEGRID_FTP_HOST") or "127.0.0.1",
            port=_int(env, "FILEGRID_FTP_PORT", 21),
            user=_req(env, "FTP_USER"),
            password=_req(env, "FTP_PASSWORD"),
            max_connections=max(1, _int(env, "FILEGRID_FTP_MAX_CONNECTIONS", 4)),
            connect_timeout=_float(env, "FILEGRID_STORAGE_CONNECT_TIMEOUT_S", 3.0),
        )


@dataclass(frozen=True)
class DbSettings:
    dsn: str = field(repr=False)
    pool_max: int = 8
    chunk_size: int = 1 * MiB
    connect_timeout: float = 3.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> DbSettings:
        dsn = env.get("FILEGRID_PG_DSN", "")
        if not dsn:
            user = quote(_req(env, "POSTGRES_USER"), safe="")
            password = quote(_req(env, "POSTGRES_PASSWORD"), safe="")
            db = quote(_req(env, "POSTGRES_DB"), safe="")
            host = env.get("FILEGRID_PG_HOST") or "127.0.0.1"
            port = _int(env, "FILEGRID_PG_PORT", 5432)
            dsn = f"postgresql://{user}:{password}@{host}:{port}/{db}"
        chunk = _int(env, "FILEGRID_PG_CHUNK_SIZE", 1 * MiB)
        if not 64 * 1024 <= chunk <= 16 * MiB:
            raise ConfigError("FILEGRID_PG_CHUNK_SIZE must be between 64 KiB and 16 MiB")
        return cls(
            dsn=dsn,
            pool_max=max(1, _int(env, "FILEGRID_PG_POOL_MAX", 8)),
            chunk_size=chunk,
            connect_timeout=_float(env, "FILEGRID_STORAGE_CONNECT_TIMEOUT_S", 3.0),
        )


@dataclass(frozen=True)
class ResilienceSettings:
    breaker_failures: int = 5
    breaker_reset_s: float = 10.0
    health_interval_s: float = 5.0
    health_timeout_s: float = 2.0
    idle_timeout_s: float = 30.0
    op_timeout_s: float = 10.0

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> ResilienceSettings:
        return cls(
            breaker_failures=max(1, _int(env, "FILEGRID_STORAGE_BREAKER_FAILURES", 5)),
            breaker_reset_s=_float(env, "FILEGRID_STORAGE_BREAKER_RESET_S", 10.0),
            health_interval_s=_float(env, "FILEGRID_STORAGE_HEALTH_INTERVAL_S", 5.0),
            health_timeout_s=_float(env, "FILEGRID_STORAGE_HEALTH_TIMEOUT_S", 2.0),
            idle_timeout_s=_float(env, "FILEGRID_STORAGE_IDLE_TIMEOUT_S", 30.0),
            op_timeout_s=_float(env, "FILEGRID_STORAGE_OP_TIMEOUT_S", 10.0),
        )


@dataclass(frozen=True)
class StorageSettings:
    s3: S3Settings
    ftp: FtpSettings
    db: DbSettings
    resilience: ResilienceSettings

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> StorageSettings:
        return cls(
            s3=S3Settings.from_env(env),
            ftp=FtpSettings.from_env(env),
            db=DbSettings.from_env(env),
            resilience=ResilienceSettings.from_env(env),
        )
