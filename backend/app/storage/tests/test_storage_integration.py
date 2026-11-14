"""Integration tests against the real storages (S3/SeaweedFS, FTP/pure-ftpd, PostgreSQL).

Skipped unless FILEGRID_INTEGRATION=1; see conftest.py for how to run them on a laptop or in k3s.
Every object is written under ``itest/<run id>/`` and deleted afterwards.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import hashlib
import os
import secrets
import time

import aioftp
import asyncpg
import pytest
import pytest_asyncio
from prometheus_client import REGISTRY
from storage_testlib import REPORT, MiB, PatternSource, collect, digest, iterate, rss_bytes

from app.crypto import DecryptionError, Kek, Keyring, decrypt_stream, encrypt_stream
from app.storage.base import IntegrityError, ObjectNotFound, StorageUnavailable, verify_stream
from app.storage.config import DbSettings, FtpSettings, S3Settings
from app.storage.db import DbStorage
from app.storage.ftp import FtpStorage
from app.storage.metrics import use_category
from app.storage.registry import StorageRegistry, build_adapter
from app.storage.resilience import BreakerState, CircuitBreaker, CircuitOpenError, ResilientStorage
from app.storage.s3 import S3Storage

pytestmark = pytest.mark.integration

RUN = secrets.token_hex(4)
NAMES = ["s3", "ftp", "db"]
BIG_MB = {
    "s3": int(os.environ.get("FILEGRID_TEST_BIG_S3_MB") or os.environ.get("FILEGRID_TEST_BIG_MB") or 1024),
    "ftp": int(os.environ.get("FILEGRID_TEST_BIG_FTP_MB") or os.environ.get("FILEGRID_TEST_BIG_MB") or 1024),
    "db": int(os.environ.get("FILEGRID_TEST_BIG_DB_MB") or 256),
}


def k(name: str) -> str:
    return f"itest/{RUN}/{name}"


@pytest_asyncio.fixture(params=NAMES)
async def adapter(request):  # noqa: ANN001, ANN201
    a = build_adapter(request.param)
    try:
        yield a
    finally:
        await a.aclose()


async def cleanup(adapter, *keys: str) -> None:  # noqa: ANN001
    for key in keys:
        with contextlib.suppress(Exception):
            await adapter.delete(key)


# ---------------------------------------------------------------- raw access (bypasses the adapter)


async def raw_overwrite(adapter, key: str, data: bytes) -> None:  # noqa: ANN001
    """Replace the stored bytes directly in the storage, as an attacker or a disk fault would."""
    if isinstance(adapter, S3Storage):
        client = await adapter._get_client()
        await client.put_object(Bucket=adapter._bucket, Key=key, Body=data)
    elif isinstance(adapter, FtpStorage):
        s = adapter._settings
        async with aioftp.Client.context(s.host, s.port, s.user, s.password) as client:
            async with client.upload_stream(key) as stream:
                await stream.write(data)
    elif isinstance(adapter, DbStorage):
        conn = await asyncpg.connect(adapter._settings.dsn)
        try:
            await conn.execute("DELETE FROM blobstore.chunks WHERE key = $1", key)
            size = adapter._settings.chunk_size
            for seq, off in enumerate(range(0, len(data), size)):
                await conn.execute(
                    "INSERT INTO blobstore.chunks (key, seq, data) VALUES ($1, $2, $3)", key, seq, data[off : off + size]
                )
        finally:
            await conn.close()
    else:  # pragma: no cover
        raise AssertionError(adapter)


# ---------------------------------------------------------------- big streams, constant memory
# First in the file: the RSS baseline is measured before other tests fragment the heap.


@pytest.mark.asyncio
async def test_big_stream_constant_memory(adapter) -> None:  # noqa: ANN001
    size = BIG_MB[adapter.name] * MiB
    if size == 0:
        pytest.skip(f"FILEGRID_TEST_BIG_{adapter.name.upper()}_MB=0")
    key = k(f"big/{adapter.name}.bin")
    baseline = rss_bytes()
    source = PatternSource(size, chunk=MiB)
    try:
        t0 = time.perf_counter()
        result = await adapter.put_stream(key, source)
        put_s = time.perf_counter() - t0
        assert result == (size, source.sha256)

        max_get_rss = 0
        received = 0
        t0 = time.perf_counter()
        async for chunk in verify_stream(adapter.get_stream(key), source.sha256):
            if received // (16 * MiB) != (received + len(chunk)) // (16 * MiB):
                max_get_rss = max(max_get_rss, rss_bytes())  # sampled every 16 MiB
            received += len(chunk)
        get_s = time.perf_counter() - t0
        assert received == size
    finally:
        await cleanup(adapter, key)
    peak = max(source.max_rss, max_get_rss)
    growth = peak - baseline
    REPORT.append(
        f"BIG {adapter.name}: {size // MiB} MiB put {put_s:.1f}s ({size / MiB / put_s:.0f} MiB/s), "
        f"get+verify {get_s:.1f}s ({size / MiB / get_s:.0f} MiB/s), sha256 ok; "
        f"RSS baseline {baseline / MiB:.0f} MiB, peak during transfer {peak / MiB:.0f} MiB (+{growth / MiB:.0f} MiB)"
    )
    assert growth < 96 * MiB, f"memory grew by {growth / MiB:.0f} MiB while streaming {size // MiB} MiB"


# ---------------------------------------------------------------- basic contract


@pytest.mark.asyncio
@pytest.mark.parametrize("size", [0, 1, 1000, 3 * MiB + 7, 17 * MiB + 3])
async def test_put_get_delete_round_trip(adapter, size: int) -> None:  # noqa: ANN001
    key = k(f"roundtrip/{adapter.name}/{size}.bin")
    data = os.urandom(size)
    try:
        result = await adapter.put_stream(key, iterate(data, 256 * 1024))
        assert result == (size, hashlib.sha256(data).hexdigest())
        size_back, sha_back = result  # tuple-compatible contract
        if size <= MiB:
            assert await collect(verify_stream(adapter.get_stream(key), sha_back)) == data
        else:  # same check without holding a second copy in memory
            assert await digest(verify_stream(adapter.get_stream(key), sha_back)) == (size_back, sha_back)
        await adapter.delete(key)
        with pytest.raises(ObjectNotFound):
            await collect(adapter.get_stream(key))
        await adapter.delete(key)  # idempotent
    finally:
        await cleanup(adapter, key)


@pytest.mark.asyncio
async def test_top_level_key_and_missing_key(adapter) -> None:  # noqa: ANN001
    key = f"itest-{RUN}-top-{adapter.name}.bin"
    try:
        await adapter.put_stream(key, iterate(b"top"))
        assert await collect(adapter.get_stream(key)) == b"top"
    finally:
        await cleanup(adapter, key)
    with pytest.raises(ObjectNotFound):
        await collect(adapter.get_stream(k(f"never/written/{adapter.name}")))


@pytest.mark.asyncio
async def test_overwrite_replaces_object(adapter) -> None:  # noqa: ANN001
    key = k(f"overwrite/{adapter.name}.bin")
    try:
        await adapter.put_stream(key, iterate(os.urandom(2 * MiB)))
        await adapter.put_stream(key, iterate(b"v2"))
        assert await collect(adapter.get_stream(key)) == b"v2"
    finally:
        await cleanup(adapter, key)


@pytest.mark.asyncio
async def test_failed_put_keeps_previous_version_and_leaves_no_partial(adapter, monkeypatch) -> None:  # noqa: ANN001
    key = k(f"atomic/{adapter.name}.bin")
    tmp_token = "feedfacecafebeef"
    monkeypatch.setattr("app.storage.ftp.secrets.token_hex", lambda n: tmp_token)

    async def client_dies_midway():
        for _ in range(10):  # 10 MiB: beyond one 8 MiB S3 part, so the multipart path is exercised
            yield os.urandom(MiB)
        raise RuntimeError("client went away")

    try:
        await adapter.put_stream(key, iterate(b"version 1"))
        with pytest.raises(RuntimeError, match="client went away"):
            await adapter.put_stream(key, client_dies_midway())
        assert await collect(adapter.get_stream(key)) == b"version 1"

        if isinstance(adapter, FtpStorage):
            s = adapter._settings
            tmp_path = f"itest/{RUN}/atomic/.ftp.bin.{tmp_token}.part"
            async with aioftp.Client.context(s.host, s.port, s.user, s.password) as client:
                assert not await client.exists(tmp_path)
                # positive control: the server does report hidden dot-files when they exist
                control = f"itest/{RUN}/atomic/.control.part"
                async with client.upload_stream(control) as stream:
                    await stream.write(b"x")
                assert await client.exists(control)
                await client.remove_file(control)
        if isinstance(adapter, S3Storage):
            client = await adapter._get_client()
            uploads = await client.list_multipart_uploads(Bucket=adapter._bucket, Prefix=key)
            assert not uploads.get("Uploads"), "multipart upload was not aborted"
    finally:
        await cleanup(adapter, key)


@pytest.mark.asyncio
async def test_early_close_releases_connections(adapter) -> None:  # noqa: ANN001
    key = k(f"early/{adapter.name}.bin")
    data = os.urandom(4 * MiB)  # several read blocks for every adapter
    try:
        await adapter.put_stream(key, iterate(data, MiB))
        async with asyncio.timeout(60):
            for _ in range(20):  # more than any pool size (FTP 4, DB 8, S3 16)
                async with contextlib.aclosing(adapter.get_stream(key)) as stream:
                    first = await anext(stream)
                    assert data.startswith(first)
            assert await digest(adapter.get_stream(key)) == (len(data), hashlib.sha256(data).hexdigest())
        assert (await adapter.health()).ok
    finally:
        await cleanup(adapter, key)


@pytest.mark.asyncio
async def test_concurrent_puts_and_gets(adapter) -> None:  # noqa: ANN001
    blobs = {k(f"concurrent/{adapter.name}/{i}.bin"): os.urandom(2 * MiB + i) for i in range(8)}
    try:
        async with asyncio.timeout(120):
            results = await asyncio.gather(*(adapter.put_stream(key, iterate(d, MiB)) for key, d in blobs.items()))
            for (key, d), r in zip(blobs.items(), results, strict=True):
                assert r == (len(d), hashlib.sha256(d).hexdigest())
            back = await asyncio.gather(*(digest(adapter.get_stream(key)) for key in blobs))
        assert back == [(len(d), hashlib.sha256(d).hexdigest()) for d in blobs.values()]
    finally:
        await cleanup(adapter, *blobs)


# ---------------------------------------------------------------- integrity


@pytest.mark.asyncio
async def test_corruption_in_storage_is_detected(adapter) -> None:  # noqa: ANN001
    key = k(f"corrupt/{adapter.name}.bin")
    data = os.urandom(3 * MiB)
    try:
        _, sha = await adapter.put_stream(key, iterate(data))
        broken = bytearray(data)
        broken[MiB + 12345] ^= 0x01  # one flipped bit, same size
        await raw_overwrite(adapter, key, bytes(broken))
        with pytest.raises(IntegrityError, match="sha256 mismatch"):
            await collect(verify_stream(adapter.get_stream(key), sha))
    finally:
        await cleanup(adapter, key)


@pytest.mark.asyncio
async def test_db_missing_chunk_row_is_detected() -> None:
    db = build_adapter("db")
    key = k("corrupt/db-truncated.bin")
    try:
        await db.put_stream(key, iterate(os.urandom(3 * MiB)))
        conn = await asyncpg.connect(db._settings.dsn)
        try:
            await conn.execute("DELETE FROM blobstore.chunks WHERE key = $1 AND seq = 1", key)
        finally:
            await conn.close()
        with pytest.raises(IntegrityError, match="expected"):
            await collect(db.get_stream(key))
    finally:
        await cleanup(db, key)
        await db.aclose()


# ---------------------------------------------------------------- encryption at rest


@pytest.mark.asyncio
async def test_encrypted_document_is_ciphertext_at_rest(adapter) -> None:  # noqa: ANN001
    key = k(f"encrypted/{adapter.name}.bin")
    kek = Kek.generate("itest")  # a throwaway key: never stored anywhere
    marker = b"CNP 1850101223344 Ion Popescu, Str. Exemplu 1, Constanta"
    document = (marker + b"\n") * 30_000  # ~1.7 MiB of personal data
    try:
        size, sha = await adapter.put_stream(key, encrypt_stream(iterate(document), kek))
        raw = await collect(verify_stream(adapter.get_stream(key), sha))  # what an attacker with storage access gets
        assert len(raw) == size and raw[:4] == b"FGE1"
        for leak in (marker, b"Popescu", b"1850101223344"):
            assert leak not in raw
        plain = await collect(decrypt_stream(verify_stream(adapter.get_stream(key), sha), Keyring(kek)))
        assert plain == document
        with pytest.raises(DecryptionError):
            await collect(decrypt_stream(adapter.get_stream(key), Keyring(Kek.generate("itest"))))
        REPORT.append(
            f"ENCRYPTION {adapter.name}: {len(document)} B plaintext -> {size} B ciphertext at rest, "
            f"marker absent from raw object, decrypt ok, wrong KEK rejected"
        )
    finally:
        await cleanup(adapter, key)


# ---------------------------------------------------------------- resilience against real failures


def unreachable(name: str, mode: str):  # noqa: ANN201
    """An adapter pointing at an endpoint that refuses connections or silently drops packets."""
    host = "127.0.0.1" if mode == "refused" else "192.0.2.1"  # 192.0.2.0/24 = TEST-NET-1, never routed
    port = 1 if mode == "refused" else 9
    if name == "s3":
        return S3Storage(dataclasses.replace(S3Settings.from_env(), endpoint=f"http://{host}:{port}", connect_timeout=0.5))
    if name == "ftp":
        return FtpStorage(dataclasses.replace(FtpSettings.from_env(), host=host, port=port, connect_timeout=0.5))
    dsn = f"postgresql://nobody:nothing@{host}:{port}/none"
    return DbStorage(dataclasses.replace(DbSettings.from_env(), dsn=dsn, connect_timeout=0.5))


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["refused", "blackhole"])
@pytest.mark.parametrize("name", NAMES)
async def test_breaker_fails_fast_against_unreachable_storage(name: str, mode: str) -> None:
    broken = ResilientStorage(unreachable(name, mode), CircuitBreaker(f"itest-{name}-{mode}", 3, 60))
    healthy = ResilientStorage(build_adapter("db" if name != "db" else "s3"), CircuitBreaker(f"itest-ok-{name}-{mode}"))
    try:
        slow = []
        for _ in range(3):
            t0 = time.perf_counter()
            with pytest.raises(StorageUnavailable):
                await broken.put_stream(k("never.bin"), iterate(b"x"))
            slow.append(time.perf_counter() - t0)
        assert broken.breaker.state is BreakerState.OPEN

        fast = []
        for _ in range(100):
            t0 = time.perf_counter()
            with pytest.raises(CircuitOpenError):
                await broken.put_stream(k("never.bin"), iterate(b"x"))
            fast.append(time.perf_counter() - t0)
        fast.sort()
        assert fast[50] < 0.001 and fast[98] < 0.005

        # The other storage keeps working while this one is down.
        key = k(f"isolation/{name}-{mode}.bin")
        t0 = time.perf_counter()
        with use_category("fault_records"):
            await healthy.put_stream(key, iterate(b"still working"))
            assert await collect(healthy.get_stream(key)) == b"still working"
            await healthy.delete(key)
        other_s = time.perf_counter() - t0
        REPORT.append(
            f"BREAKER {name}/{mode}: failing calls took {min(slow) * 1000:.0f}-{max(slow) * 1000:.0f} ms, then "
            f"open: median {fast[50] * 1e6:.0f} us, p99 {fast[98] * 1e6:.0f} us; "
            f"{healthy.name} put+get+delete meanwhile {other_s * 1000:.0f} ms"
        )
    finally:
        await broken.aclose()
        await healthy.aclose()


@pytest.mark.asyncio
async def test_registry_health_and_metrics_with_real_storages() -> None:
    registry = StorageRegistry.from_env()
    try:
        await registry.start(monitor=False)
        # An FTP login can outlast one 2 s probe on a busy host; it continues in the background and the
        # next probe succeeds (as with the real HealthMonitor, which polls every 5 s and trips after 2).
        for probe in range(1, 4):
            statuses = await registry.monitor.check_once()
            if all(s.ok for s in statuses.values()):
                break
            await asyncio.sleep(2)
        assert {n: s.ok for n, s in statuses.items()} == {"s3": True, "ftp": True, "db": True}, statuses
        for name in NAMES:
            assert REGISTRY.get_sample_value("filegrid_storage_up", {"storage": name}) == 1
        status = registry.status()
        assert all(v["circuit"] == "closed" for v in status.values())

        key = k("registry/metrics.bin")
        for name in NAMES:
            storage = registry.get(name)
            labels = {"storage": name, "operation": "put", "category": "meter_readings"}
            before = REGISTRY.get_sample_value("filegrid_storage_bytes_total", labels) or 0
            with use_category("meter_readings"):
                await storage.put_stream(key, iterate(b"r" * 4096))
                assert await collect(storage.get_stream(key)) == b"r" * 4096
                await storage.delete(key)
            assert REGISTRY.get_sample_value("filegrid_storage_bytes_total", labels) == before + 4096
        REPORT.append(
            f"HEALTH (all up at probe {probe}): "
            + ", ".join(f"{n} {s.detail} in {s.latency_ms:.1f} ms" for n, s in statuses.items())
        )
    finally:
        await registry.aclose()


@pytest.mark.asyncio
async def test_db_ensure_schema_is_idempotent_and_concurrent() -> None:
    adapters = [build_adapter("db") for _ in range(4)]
    try:
        await asyncio.gather(*(a.ensure_schema() for a in adapters))
        await asyncio.gather(*(a.ensure_schema() for a in adapters))
    finally:
        for a in adapters:
            await a.aclose()
