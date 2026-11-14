"""FTP adapter (pure-ftpd in FileGrid), passive mode (EPSV first, PASV as fallback).

Write path: the object is streamed to a hidden temporary name in the target directory
(``dir/.name.<random>.part``) and renamed onto the final key only after the server confirmed the
transfer (226). A reader therefore never sees a partial file; on any error or cancellation the
temporary file is removed on a fresh connection (best effort). Parent directories of keys with ``/``
are created on demand (``MKD``, "already exists" ignored) and remembered per process.

Read path: ``RETR`` on a passive data connection, read in blocks of at most 256 KiB. Closing the
iterator early closes the data and control connections (an interrupted transfer leaves the FTP
control channel in an unknown state, so that connection is never reused).

Connections: a small pool of logged-in control connections, bounded by
``FILEGRID_FTP_MAX_CONNECTIONS`` (default 4) because pure-ftpd runs with ``-c 5 -C 5``. Idle connections
are reused for at most 20 s and only after an operation that finished cleanly. ``health()`` uses its own
short-lived connection so that a pool busy with long video transfers is never reported as "down".

Settings: see ``config.FtpSettings`` (FILEGRID_FTP_HOST, FILEGRID_FTP_PORT, FTP_USER, FTP_PASSWORD, ...).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
import time
from collections.abc import AsyncIterable, AsyncIterator
from pathlib import PurePosixPath

import aioftp

from .base import (
    HashingStream,
    HealthStatus,
    ObjectNotFound,
    PutResult,
    StorageAdapter,
    StorageError,
    StorageUnavailable,
    validate_key,
)
from .config import FtpSettings

__all__ = ["FtpStorage"]

log = logging.getLogger("filegrid.storage.ftp")

READ_BLOCK = 256 * 1024
IDLE_TTL_S = 20.0
_MAX_KNOWN_DIRS = 4096


def _codes(exc: aioftp.StatusCodeError) -> set[str]:
    return {str(code) for code in exc.received_codes}


def _translate(exc: BaseException, key: str | None = None) -> BaseException:
    if isinstance(exc, StorageError):
        return exc
    if isinstance(exc, aioftp.StatusCodeError):
        codes = _codes(exc)
        if codes & {"421", "425", "426", "450", "451", "452"}:
            return StorageUnavailable(f"ftp: status {'/'.join(sorted(codes))}")
        return StorageError(f"ftp: status {'/'.join(sorted(codes))}")
    if isinstance(exc, (OSError, asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError, EOFError)):
        return StorageUnavailable(f"ftp: {type(exc).__name__}")
    return exc


class _Pool:
    def __init__(self, settings: FtpSettings):
        self._s = settings
        self._sem = asyncio.Semaphore(settings.max_connections)
        self._idle: list[tuple[float, aioftp.Client]] = []

    async def connect(self) -> aioftp.Client:
        s = self._s
        client = aioftp.Client(socket_timeout=s.socket_timeout, connection_timeout=s.connect_timeout)
        try:
            await client.connect(s.host, s.port)
            await client.login(s.user, s.password)
        except BaseException:
            client.close()
            raise
        return client

    @contextlib.asynccontextmanager
    async def client(self) -> AsyncIterator[aioftp.Client]:
        async with self._sem:
            client = None
            now = time.monotonic()
            while self._idle:
                since, candidate = self._idle.pop()
                if now - since < IDLE_TTL_S:
                    client = candidate
                    break
                candidate.close()
            if client is None:
                client = await self.connect()
            clean = False
            try:
                yield client
                clean = True
            finally:
                if clean:
                    self._idle.append((time.monotonic(), client))
                else:
                    client.close()

    def close(self) -> None:
        idle, self._idle = self._idle, []
        for _, client in idle:
            client.close()


class FtpStorage(StorageAdapter):
    name = "ftp"

    def __init__(self, settings: FtpSettings, *, name: str = "ftp"):
        self.name = name
        self._settings = settings
        self._pool = _Pool(settings)
        self._known_dirs: set[str] = set()

    async def _ensure_dir(self, client: aioftp.Client, directory: PurePosixPath) -> None:
        if directory == PurePosixPath(".") or str(directory) in self._known_dirs:
            return
        current = PurePosixPath()
        for part in directory.parts:
            current = current / part
            if str(current) in self._known_dirs:
                continue
            try:
                await client.command(f"MKD {current}", "257")
            except aioftp.StatusCodeError as exc:
                if "550" not in _codes(exc):  # 550 = already exists (or not permitted: STOR will tell)
                    raise
            if len(self._known_dirs) > _MAX_KNOWN_DIRS:
                self._known_dirs.clear()
            self._known_dirs.add(str(current))

    async def put_stream(self, key: str, chunks: AsyncIterable[bytes]) -> PutResult:
        validate_key(key)
        path = PurePosixPath(key)
        tmp = path.parent / f".{path.name}.{secrets.token_hex(8)}.part"
        hashing = HashingStream(chunks)
        try:
            async with self._pool.client() as client:
                await self._ensure_dir(client, path.parent)
                async with client.upload_stream(tmp) as stream:
                    async for chunk in hashing:
                        if chunk:
                            await stream.write(chunk)
                # upload_stream's clean exit waited for "226 transfer complete": tmp is fully written
                await client.rename(tmp, path)  # pure-ftpd RNFR/RNTO = rename(2): atomic replace
            return hashing.result()
        except BaseException as exc:
            self._known_dirs.clear()
            await hashing.aclose()
            await self._remove_quietly(tmp)
            translated = _translate(exc, key)
            if translated is exc:
                raise
            raise translated from exc

    async def _remove_quietly(self, path: PurePosixPath) -> None:
        try:
            async with asyncio.timeout(5):
                async with self._pool.client() as client:
                    try:
                        await client.remove_file(path)
                    except aioftp.StatusCodeError as exc:
                        if "550" not in _codes(exc):
                            raise
        except BaseException as exc:  # noqa: BLE001 - best effort cleanup
            log.warning("ftp: could not remove temporary file %s: %s", path, type(exc).__name__)
            if isinstance(exc, asyncio.CancelledError):
                raise

    def get_stream(self, key: str) -> AsyncIterator[bytes]:
        validate_key(key)
        return self._get(key)

    async def _get(self, key: str) -> AsyncIterator[bytes]:
        try:
            async with self._pool.client() as client:
                try:
                    stream = await client.download_stream(key)
                except aioftp.StatusCodeError as exc:
                    if "550" in _codes(exc):
                        raise ObjectNotFound(f"ftp: no object {key!r}") from None
                    raise
                ok = False
                try:
                    async for block in stream.iter_by_block(READ_BLOCK):
                        yield block
                    ok = True
                finally:
                    if ok:
                        await stream.finish()  # wait for 226: the server sent the whole file
                    else:
                        stream.close()
        except (StorageError, GeneratorExit, asyncio.CancelledError):
            raise
        except Exception as exc:
            raise _translate(exc, key) from exc

    async def delete(self, key: str) -> None:
        validate_key(key)
        try:
            async with self._pool.client() as client:
                try:
                    await client.remove_file(key)
                except aioftp.StatusCodeError as exc:
                    if "550" not in _codes(exc):  # missing file: idempotent delete
                        raise
        except Exception as exc:
            raise _translate(exc, key) from exc

    async def health(self) -> HealthStatus:
        start = time.perf_counter()
        client = None
        try:
            client = await self._pool.connect()
            await client.command("NOOP", "2xx")
            with contextlib.suppress(Exception):
                await client.quit()
        except Exception as exc:  # noqa: BLE001 - health never raises
            return HealthStatus(False, (time.perf_counter() - start) * 1000, str(_translate(exc)))
        finally:
            if client is not None:
                client.close()
        return HealthStatus(True, (time.perf_counter() - start) * 1000, "login + NOOP ok")

    async def aclose(self) -> None:
        self._pool.close()
