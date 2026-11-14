"""Unit test: FTP health keeps one logged-in connection and survives logins slower than the probe timeout."""

from __future__ import annotations

import asyncio

import pytest

from app.storage.config import FtpSettings
from app.storage.ftp import FtpStorage
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
