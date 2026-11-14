"""Unit tests: key validation, hashing, verify_stream, rechunk, settings (no storage needed)."""

from __future__ import annotations

import contextlib
import hashlib
import os

import pytest
from storage_testlib import collect, iterate

from app.storage.base import (
    HashingStream,
    IntegrityError,
    InvalidKey,
    PutResult,
    rechunk,
    validate_key,
    verify_stream,
)
from app.storage.config import ConfigError, DbSettings, FtpSettings, S3Settings, StorageSettings


@pytest.mark.parametrize(
    "key",
    ["a", "fault_records/2026/11/14/3f2a9c.bin", "x.y-z_1", "_hidden_not_dot", "a/b/c/d.e.f", "A" * 512],
)
def test_valid_keys(key: str) -> None:
    assert validate_key(key) == key


@pytest.mark.parametrize(
    "key",
    [
        "",
        "/abs",
        "a//b",
        "a/",
        "..",
        "a/../b",
        "./a",
        "a/.",
        ".hidden",
        "dir/.x.part",
        "-rf",
        "a b",
        "a\\b",
        "a\nb",
        "ă",
        "a?b",
        "a" * 513,
        None,
        123,
    ],
)
def test_invalid_keys(key) -> None:  # noqa: ANN001
    with pytest.raises(InvalidKey):
        validate_key(key)


def test_invalid_key_is_value_error() -> None:
    with pytest.raises(ValueError):
        validate_key("../etc/passwd")


def test_put_result_is_tuple_compatible() -> None:
    size, sha = PutResult(3, "ab")
    assert (size, sha) == (3, "ab")
    assert PutResult(3, "ab") == (3, "ab")


@pytest.mark.asyncio
async def test_hashing_stream_passes_data_and_hashes() -> None:
    data = os.urandom(300_000)
    hs = HashingStream(iterate(data, 7000))
    assert await collect(hs) == data
    assert hs.result() == (len(data), hashlib.sha256(data).hexdigest())


@pytest.mark.asyncio
async def test_verify_stream_accepts_intact_data() -> None:
    data = os.urandom(100_000)
    out = await collect(verify_stream(iterate(data), hashlib.sha256(data).hexdigest().upper()))
    assert out == data


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["flip", "truncate", "append"])
async def test_verify_stream_detects_corruption(corruption: str) -> None:
    data = bytearray(os.urandom(200_000))
    expected = hashlib.sha256(data).hexdigest()
    if corruption == "flip":
        data[123_456] ^= 0x01
    elif corruption == "truncate":
        del data[-1:]
    else:
        data += b"\0"
    seen = bytearray()
    with pytest.raises(IntegrityError, match="sha256 mismatch"):
        async for chunk in verify_stream(iterate(bytes(data)), expected):
            seen += chunk
    assert bytes(seen) == bytes(data)  # data flowed through; the verdict comes at the end


@pytest.mark.asyncio
async def test_verify_stream_closes_source_on_early_exit() -> None:
    closed = False

    async def source():
        nonlocal closed
        try:
            for _ in range(100):
                yield b"x" * 1000
        finally:
            closed = True

    async with contextlib.aclosing(verify_stream(source(), "00" * 32)) as stream:
        async for _ in stream:
            break
    assert closed


@pytest.mark.asyncio
@pytest.mark.parametrize("total", [0, 1, 4095, 4096, 4097, 3 * 4096, 50_000])
@pytest.mark.parametrize("piece", [1, 1000, 4096, 9000, 100_000])
async def test_rechunk_exact_blocks(total: int, piece: int) -> None:
    data = os.urandom(total)
    blocks = [b async for b in rechunk(iterate(data, piece), 4096)]
    assert b"".join(blocks) == data
    assert all(len(b) == 4096 for b in blocks[:-1])
    if blocks:
        assert 0 < len(blocks[-1]) <= 4096


@pytest.mark.asyncio
async def test_rechunk_skips_empty_chunks() -> None:
    async def source():
        for c in (b"", b"ab", b"", b"cd", b""):
            yield c

    assert [b async for b in rechunk(source(), 3)] == [b"abc", b"d"]


ENV = {
    "S3_ACCESS_KEY": "AKIA-test-access",
    "S3_SECRET_KEY": "very-secret-s3-key",
    "FTP_USER": "ftpuser",
    "FTP_PASSWORD": "very-secret-ftp-pass",
    "POSTGRES_USER": "fg",
    "POSTGRES_PASSWORD": "p@ss/word:with#chars",
    "POSTGRES_DB": "filegrid",
}


def test_settings_defaults_target_laptop_compose() -> None:
    s = StorageSettings.from_env(ENV)
    assert s.s3.endpoint == "http://127.0.0.1:9000"
    assert s.s3.bucket == "filegrid"
    assert (s.ftp.host, s.ftp.port) == ("127.0.0.1", 21)
    assert s.db.dsn.startswith("postgresql://fg:")
    assert "@127.0.0.1:5432/filegrid" in s.db.dsn
    assert "p%40ss%2Fword%3Awith%23chars" in s.db.dsn  # password is URL-encoded in the DSN
    assert s.resilience.breaker_failures == 5
    assert s.resilience.breaker_reset_s == 10.0


def test_settings_cluster_overrides() -> None:
    env = dict(
        ENV,
        FILEGRID_S3_ENDPOINT="http://s3.filegrid-storage.svc.cluster.local:8333",
        FILEGRID_FTP_HOST="ftp.filegrid-storage.svc.cluster.local",
        FILEGRID_PG_HOST="postgres.filegrid-storage.svc.cluster.local",
        FILEGRID_FTP_MAX_CONNECTIONS="3",
    )
    s = StorageSettings.from_env(env)
    assert s.s3.endpoint.endswith(":8333")
    assert s.ftp.host.startswith("ftp.")
    assert s.ftp.max_connections == 3
    assert "@postgres.filegrid-storage.svc.cluster.local:5432/" in s.db.dsn
    assert DbSettings.from_env({"FILEGRID_PG_DSN": "postgresql://x@y/z"}).dsn == "postgresql://x@y/z"


def test_settings_never_show_secrets() -> None:
    s = StorageSettings.from_env(ENV)
    text = repr(s) + str(s)
    for secret in ("very-secret-s3-key", "AKIA-test-access", "very-secret-ftp-pass", "p@ss", "p%40ss"):
        assert secret not in text


@pytest.mark.parametrize(
    "factory,missing",
    [(S3Settings.from_env, "S3_SECRET_KEY"), (FtpSettings.from_env, "FTP_PASSWORD"), (DbSettings.from_env, "POSTGRES_PASSWORD")],
)
def test_settings_missing_credentials(factory, missing: str) -> None:  # noqa: ANN001
    env = {k: v for k, v in ENV.items() if k != missing}
    with pytest.raises(ConfigError, match=missing):
        factory(env)


def test_s3_part_size_minimum() -> None:
    with pytest.raises(ConfigError):
        S3Settings.from_env(dict(ENV, FILEGRID_S3_PART_SIZE=str(1024 * 1024)))
