"""Unit tests for the FTP adapter: health connection handling and control-channel resync after an abort."""

from __future__ import annotations

import asyncio

import aioftp
import pytest

from app.storage.config import FtpSettings
from app.storage.ftp import FtpStorage, _resync_after_abort
from app.storage.resilience import BreakerState, CircuitBreaker, ResilientStorage


class FakeClient:
    def __init__(self) -> None:
        self.commands: list[str] = []
        self.closed = False
        self.broken = False

    async def command(self, cmd: str, *_args) -> None:  # noqa: ANN002
        if self.broken:
            raise ConnectionResetError("server went away")
        self.commands.append(cmd)

    def close(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_slow_login_is_not_restarted_by_every_probe(monkeypatch) -> None:  # noqa: ANN001
    adapter = FtpStorage(FtpSettings(host="ftp.invalid", user="u", password="p"))
    logins: list[FakeClient] = []

    async def slow_connect() -> FakeClient:
        await asyncio.sleep(0.3)  # login slower than the 0.1 s probe timeout
        client = FakeClient()
        logins.append(client)
        return client

    monkeypatch.setattr(adapter._pool, "connect", slow_connect)
    rs = ResilientStorage(adapter, CircuitBreaker("t-ftp-health", 5, 60), health_timeout=0.1)

    first = await rs.check_health(trip_after=5)
    assert not first.ok and "timed out" in first.detail
    await asyncio.sleep(0.3)  # the shielded login finished in the background
    second = await rs.check_health(trip_after=5)
    assert second.ok and second.latency_ms >= 250  # reports how long the login took
    third = await rs.check_health(trip_after=5)
    assert third.ok and third.detail == "NOOP ok"
    assert len(logins) == 1  # one login, then NOOPs on the same connection

    logins[0].broken = True  # server restarted: the next probe logs in again
    fourth = await rs.check_health(trip_after=5)
    assert not fourth.ok
    await asyncio.sleep(0.3)
    assert (await rs.check_health(trip_after=5)).ok
    assert len(logins) == 2 and logins[0].closed
    assert rs.breaker.state is BreakerState.CLOSED
    await rs.aclose()
    assert logins[1].closed


class ReplyScript:
    """Fake control channel: each read returns the next scripted reply code."""

    def __init__(self, replies: list[str], hang: bool = False) -> None:
        self.replies = replies
        self.hang = hang
        self.sent: list[str | None] = []

    async def command(self, cmd: str | None, expected: str) -> None:
        self.sent.append(cmd)
        if not self.replies:
            if self.hang:
                await asyncio.sleep(3600)
            raise ConnectionResetError
        code = self.replies.pop(0)
        if code != expected:
            raise aioftp.StatusCodeError(aioftp.Code(expected), aioftp.Code(code), ["stale"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "replies,in_sync",
    [
        (["200"], True),  # no reply was pending: NOOP answered directly
        (["426", "200"], True),  # one stale transfer reply, then the NOOP's 200
        (["451", "226", "200"], True),  # two stale replies
        (["426", "226", "226", "200"], False),  # more than expected: do not trust the channel
        (["550"], False),  # then the channel breaks
    ],
)
async def test_resync_after_abort(replies: list[str], in_sync: bool) -> None:
    script = ReplyScript(list(replies))
    assert await _resync_after_abort(script) is in_sync
    assert script.sent[0] == "NOOP" and all(c is None for c in script.sent[1:])


@pytest.mark.asyncio
async def test_resync_gives_up_after_timeout(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr("app.storage.ftp.RESYNC_TIMEOUT_S", 0.05)
    assert await _resync_after_abort(ReplyScript([], hang=True)) is False
