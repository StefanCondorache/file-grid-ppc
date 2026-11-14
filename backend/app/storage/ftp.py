"""FTP adapter (pure-ftpd in FileGrid), passive mode (EPSV first, PASV as fallback).

Write path: the object is streamed to a hidden temporary name in the target directory
(``dir/.name.<random>.part``) and renamed onto the final key only after the server confirmed the
transfer (226). A reader therefore never sees a partial file; on any error or cancellation the
temporary file is removed on a fresh connection (best effort). Parent directories of keys with ``/``
are created on demand (``MKD``, "already exists" ignored) and remembered per process.

Read path: ``RETR`` on a passive data connection, read in blocks of at most 256 KiB. Closing the
iterator early closes the data connection; the control connection goes back to the pool only if a
``NOOP`` proves it is still in sync (see ``_resync_after_abort``), otherwise it is closed. Any other
error closes both.

Connections: a small pool of logged-in control connections, bounded by
``FILEGRID_FTP_MAX_CONNECTIONS`` (default 4) to stay within pure-ftpd's session limits (``-c`` total,
``-C`` per client IP; the image's defaults are ``-c 5 -C 5``). Logging in is slow: about 1 s in k3s
and 3-4 s in Docker on the 2-core VPS, spent after ``PASS`` (consistent with pure-ftpd's memory-hard
password hash; ``-H`` does not remove it). So idle connections are kept for up to 120 s and reused, but
only after an operation that finished cleanly. ``health()`` keeps one dedicated logged-in connection outside the pool
and sends ``NOOP`` on it (reconnecting when it broke): a pool busy with long video transfers is never
reported as "down", and probing every 5 s does not cost a login each time.

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
IDLE_TTL_S = 120.0
RESYNC_TIMEOUT_S = 2.0
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


class _Lease:
    __slots__ = ("client", "reusable")

    def __init__(self, client: aioftp.Client):
        self.client = client
        self.reusable = False


async def _resync_after_abort(client: aioftp.Client) -> bool:
    """After the data connection was closed mid-transfer: True if the control channel is provably in sync.

    pure-ftpd may or may not send a final reply (226/426/451) for the aborted transfer. A NOOP is
    answered with 200, a code no transfer reply uses, so: send NOOP and read replies until the 200,
    skipping at most two stale transfer replies. Anything else (or no 200 within 2 s) => not in sync.
    """
    try:
        async with asyncio.timeout(RESYNC_TIMEOUT_S):
            for attempt in range(3):
                try:
                    await client.command("NOOP" if attempt == 0 else None, "200")
                    return True
                except aioftp.StatusCodeError:
                    continue  # consumed a stale reply of the aborted transfer
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - any doubt means "do not reuse"
        return False
    return False


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
    async def lease(self) -> AsyncIterator[_Lease]:
        """A pooled connection. It goes back to the pool after a clean exit, or after an exception only
        if the code set ``lease.reusable = True`` (it proved the control channel is still in sync)."""
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
            lease = _Lease(client)
            try:
                yield lease
                lease.reusable = True
            finally:
                if lease.reusable:
                    self._idle.append((time.monotonic(), client))
                else:
                    client.close()

    @contextlib.asynccontextmanager
    async def client(self) -> AsyncIterator[aioftp.Client]:
        async with self.lease() as lease:
            yield lease.client

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
        self._health_client: aioftp.Client | None = None
        self._health_login: asyncio.Task | None = None
        self._health_lock = asyncio.Lock()

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
        stored = False  # True once STOR may have created the temporary file
        try:
            async with self._pool.client() as client:
                await self._ensure_dir(client, path.parent)
                stored = True
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
            if stored:  # never pay a second connect timeout when the server was not even reachable
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
            async with self._pool.lease() as lease:
                client = lease.client
                try:
                    stream = await client.download_stream(key)
                except aioftp.StatusCodeError as exc:
                    if "550" in _codes(exc):
                        raise ObjectNotFound(f"ftp: no object {key!r}") from None
                    raise
                try:
                    async for block in stream.iter_by_block(READ_BLOCK):
                        yield block
                except GeneratorExit:
                    # The consumer stopped early (cancelled download, partial read). Logging in again
                    # costs seconds on pure-ftpd, so keep the connection if the channel is in sync.
                    stream.close()
                    lease.reusable = await _resync_after_abort(client)
                    raise
                except BaseException:
                    stream.close()
                    raise
                await stream.finish()  # wait for 226: the server sent the whole file
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
        async with self._health_lock:
            start = time.perf_counter()
            if self._health_client is not None:
                try:
                    await self._health_client.command("NOOP", "2xx")
                    return HealthStatus(True, (time.perf_counter() - start) * 1000, "NOOP ok")
                except Exception:
                    self._drop_health_client()  # broken (server restarted?): log in again below
                    start = time.perf_counter()
                except BaseException:  # cancelled (probe timeout): the connection state is unknown
                    self._drop_health_client()
                    raise
            # The login runs in its own task, shielded from the probe's timeout: when a login takes
            # longer than one probe (slow hash on a busy host) it still completes, and the next probe
            # only sends NOOP instead of starting another login that would be cut off again.
            if self._health_login is None:
                self._health_login = asyncio.create_task(self._login_for_health(), name="ftp-health-login")
            try:
                client, login_ms = await asyncio.shield(self._health_login)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - health never raises
                self._health_login = None
                return HealthStatus(False, (time.perf_counter() - start) * 1000, str(_translate(exc)))
            self._health_login = None
            self._health_client = client
            # latency = how long the login took, even if an earlier probe had already given up on it
            return HealthStatus(True, login_ms, "login + NOOP ok")

    async def _login_for_health(self) -> tuple[aioftp.Client, float]:
        start = time.perf_counter()
        client = await self._pool.connect()
        try:
            await client.command("NOOP", "2xx")
        except BaseException:
            client.close()
            raise
        return client, (time.perf_counter() - start) * 1000

    def _drop_health_client(self) -> None:
        client, self._health_client = self._health_client, None
        if client is not None:
            client.close()

    async def aclose(self) -> None:
        login, self._health_login = self._health_login, None
        if login is not None:
            login.cancel()
            with contextlib.suppress(BaseException):
                client, _ = await login
                client.close()
        self._drop_health_client()
        self._pool.close()
