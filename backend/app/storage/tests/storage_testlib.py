"""Helpers for the storage test suites (imported as a top-level module: pytest puts this folder on sys.path)."""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import AsyncIterator
from pathlib import Path

MiB = 1024 * 1024


def _status_kib(field: str) -> int | None:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith(field + ":"):
                return int(line.split()[1])
    except OSError:
        return None
    return None


def rss_bytes() -> int:
    """Current resident set size of this process."""
    kib = _status_kib("VmRSS")
    return (kib or 0) * 1024


def peak_rss_bytes() -> int:
    """Peak resident set size of this process since it started (VmHWM)."""
    kib = _status_kib("VmHWM")
    return (kib or 0) * 1024


class PatternSource:
    """Async generator of ``size`` pseudo-random bytes in ``chunk``-sized pieces, never held in memory.

    One random block is reused with a per-chunk counter stamped in front, so every chunk differs, the data
    does not compress, and generating 1 GiB costs one memcpy per chunk. ``sha256`` is final when exhausted.
    Tracks the RSS high-water mark seen while streaming (sampled every ``sample_every`` chunks).
    """

    def __init__(self, size: int, chunk: int = MiB, sample_every: int = 16):
        self.size = size
        self.chunk = chunk
        self.sample_every = sample_every
        self._block = secrets.token_bytes(chunk)
        self._hash = hashlib.sha256()
        self.max_rss = 0

    def chunk_at(self, index: int, length: int) -> bytes:
        return (index.to_bytes(8, "big") + self._block[8:])[:length]

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._gen()

    async def _gen(self) -> AsyncIterator[bytes]:
        sent = 0
        index = 0
        while sent < self.size:
            data = self.chunk_at(index, min(self.chunk, self.size - sent))
            self._hash.update(data)
            sent += len(data)
            if index % self.sample_every == 0:
                self.max_rss = max(self.max_rss, rss_bytes())
            index += 1
            yield data

    @property
    def sha256(self) -> str:
        return self._hash.hexdigest()


async def iterate(chunks: bytes, size: int = 64 * 1024) -> AsyncIterator[bytes]:
    """Yield ``chunks`` in pieces of ``size`` (tests use it to feed small payloads)."""
    for off in range(0, len(chunks), size):
        yield chunks[off : off + size]


async def collect(stream: AsyncIterator[bytes]) -> bytes:
    return b"".join([c async for c in stream])


# Lines collected by the integration tests and printed by conftest.py at the end of the run
# (so throughput and memory numbers show up in the Job log without -s).
REPORT: list[str] = []


async def digest(stream: AsyncIterator[bytes]) -> tuple[int, str]:
    """(size, sha256) of a stream without keeping it in memory."""
    h = hashlib.sha256()
    size = 0
    async for chunk in stream:
        h.update(chunk)
        size += len(chunk)
    return size, h.hexdigest()
