"""Unit tests: circuit breaker state machine, fail-fast timing, idle timeouts, metrics, health monitor."""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterable, AsyncIterator

import pytest
from prometheus_client import REGISTRY
from storage_testlib import collect, iterate

from app.storage.base import (
    HealthStatus,
    IntegrityError,
    ObjectNotFound,
    PutResult,
    StorageAdapter,
    StorageUnavailable,
)
from app.storage.metrics import category_label, current_category, use_category
from app.storage.resilience import (
    BreakerState,
    CircuitBreaker,
    CircuitOpenError,
    HealthMonitor,
    IdleTimeoutError,
    ResilientStorage,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakeAdapter(StorageAdapter):
    """In-memory adapter whose behaviour the tests switch: ok, fail, hang, slow."""

    def __init__(self, name: str = "fake") -> None:
        self.name = name
        self.objects: dict[str, bytes] = {}
        self.mode = "ok"
        self.calls = 0
        self.hang_after_chunks: int | None = None
        self.health_ok = True

    async def _maybe_fail(self) -> None:
        self.calls += 1
        if self.mode == "fail":
            await asyncio.sleep(0.01)  # a real failing storage costs time (connect refused/timeout)
            raise StorageUnavailable(f"{self.name}: down")
        if self.mode == "hang":
            await asyncio.sleep(3600)

    async def put_stream(self, key: str, chunks: AsyncIterable[bytes]) -> PutResult:
        await self._maybe_fail()
        buf = bytearray()
        async for chunk in chunks:
            buf += chunk
            if self.hang_after_chunks is not None and len(buf) >= self.hang_after_chunks:
                await asyncio.sleep(3600)  # storage stops making progress mid-upload
        self.objects[key] = bytes(buf)
        import hashlib

        return PutResult(len(buf), hashlib.sha256(buf).hexdigest())

    def get_stream(self, key: str) -> AsyncIterator[bytes]:
        return self._get(key)

    async def _get(self, key: str) -> AsyncIterator[bytes]:
        await self._maybe_fail()
        if key not in self.objects:
            raise ObjectNotFound(key)
        data = self.objects[key]
        for off in range(0, len(data), 1000):
            if self.hang_after_chunks is not None and off >= self.hang_after_chunks:
                await asyncio.sleep(3600)
            yield data[off : off + 1000]

    async def delete(self, key: str) -> None:
        await self._maybe_fail()
        self.objects.pop(key, None)

    async def health(self) -> HealthStatus:
        if self.mode == "hang":
            await asyncio.sleep(3600)
        return HealthStatus(self.health_ok, 0.1, "fake")


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


# ---------------------------------------------------------------- breaker state machine


def test_breaker_opens_after_threshold_consecutive_failures() -> None:
    clock = FakeClock()
    b = CircuitBreaker("t-open", failure_threshold=5, reset_timeout=10, clock=clock)
    for _ in range(4):
        assert b.before_call() is False
        b.record_failure()
    assert b.state is BreakerState.CLOSED
    b.before_call()
    b.record_failure()
    assert b.state is BreakerState.OPEN
    with pytest.raises(CircuitOpenError):
        b.before_call()
    assert sample("filegrid_storage_circuit_state", storage="t-open") == 2


def test_breaker_success_resets_failure_count() -> None:
    b = CircuitBreaker("t-reset", failure_threshold=3, clock=FakeClock())
    for _ in range(2):
        b.record_failure()
    b.record_success()
    for _ in range(2):
        b.record_failure()
    assert b.state is BreakerState.CLOSED
    b.record_failure()
    assert b.state is BreakerState.OPEN


def test_breaker_half_open_single_trial_then_close() -> None:
    clock = FakeClock()
    b = CircuitBreaker("t-half", failure_threshold=1, reset_timeout=10, clock=clock)
    b.record_failure()
    assert b.state is BreakerState.OPEN
    clock.now += 9.9
    with pytest.raises(CircuitOpenError):
        b.before_call()
    clock.now += 0.2
    assert b.before_call() is True  # the single trial
    assert b.state is BreakerState.HALF_OPEN
    assert sample("filegrid_storage_circuit_state", storage="t-half") == 1
    with pytest.raises(CircuitOpenError, match="trial"):
        b.before_call()  # concurrent calls are rejected while the trial runs
    b.record_success(trial=True)
    assert b.state is BreakerState.CLOSED
    assert b.before_call() is False
    assert sample("filegrid_storage_circuit_state", storage="t-half") == 0


def test_breaker_failed_trial_reopens_and_restarts_timer() -> None:
    clock = FakeClock()
    b = CircuitBreaker("t-reopen", failure_threshold=1, reset_timeout=10, clock=clock)
    b.record_failure()
    clock.now += 10
    trial = b.before_call()
    b.record_failure(trial)
    assert b.state is BreakerState.OPEN
    clock.now += 5
    with pytest.raises(CircuitOpenError):
        b.before_call()
    clock.now += 5
    assert b.before_call() is True


def test_breaker_ignored_trial_frees_the_slot() -> None:
    clock = FakeClock()
    b = CircuitBreaker("t-ignored", failure_threshold=1, reset_timeout=1, clock=clock)
    b.record_failure()
    clock.now += 1
    trial = b.before_call()
    b.record_ignored(trial)  # e.g. the caller cancelled
    assert b.state is BreakerState.HALF_OPEN
    assert b.before_call() is True


def test_breaker_success_of_stale_call_does_not_close_open_breaker() -> None:
    b = CircuitBreaker("t-stale", failure_threshold=1, clock=FakeClock())
    b.record_failure()
    b.record_success(trial=False)  # a call admitted before the breaker opened
    assert b.state is BreakerState.OPEN


def test_breaker_trip_and_allow_trial() -> None:
    clock = FakeClock()
    b = CircuitBreaker("t-trip", failure_threshold=5, reset_timeout=60, clock=clock)
    b.trip()
    assert b.state is BreakerState.OPEN
    b.allow_trial()
    assert b.state is BreakerState.HALF_OPEN
    assert b.before_call() is True


# ---------------------------------------------------------------- ResilientStorage


@pytest.mark.asyncio
async def test_open_breaker_fails_fast_under_5ms() -> None:
    adapter = FakeAdapter("t-fast")
    adapter.mode = "fail"
    rs = ResilientStorage(adapter, CircuitBreaker("t-fast", failure_threshold=5, reset_timeout=60))
    for _ in range(5):
        with pytest.raises(StorageUnavailable):
            await rs.put_stream("k", iterate(b"data"))
    assert rs.breaker.state is BreakerState.OPEN
    calls_before = adapter.calls
    durations: list[float] = []
    for _ in range(200):
        for call in (
            lambda: rs.put_stream("k", iterate(b"data")),
            lambda: collect(rs.get_stream("k")),
            lambda: rs.delete("k"),
        ):
            start = time.perf_counter()
            try:
                await call()
            except CircuitOpenError:
                durations.append(time.perf_counter() - start)
    assert len(durations) == 600
    durations.sort()
    median, p99 = durations[300], durations[594]
    # The breaker answers without I/O: microseconds. p99 (not max) so one GC pause on a busy VPS
    # cannot make the test flaky.
    assert median < 0.001, f"median rejected call took {median * 1000:.3f} ms"
    assert p99 < 0.005, f"p99 rejected call took {p99 * 1000:.3f} ms"
    assert adapter.calls == calls_before  # the storage was not touched
    assert sample(
        "filegrid_storage_errors_total", storage="t-fast", operation="put", category="unknown", error_type="CircuitOpen"
    ) == 200
    assert sample(
        "filegrid_storage_operation_seconds_count", storage="t-fast", operation="put", category="unknown", outcome="rejected"
    ) == 200


@pytest.mark.asyncio
async def test_one_storage_down_does_not_block_another() -> None:
    down, up = FakeAdapter("t-down"), FakeAdapter("t-up")
    down.mode = "hang"
    rs_down = ResilientStorage(down, CircuitBreaker("t-down", 2, 60), idle_timeout=0.2)
    rs_up = ResilientStorage(up, CircuitBreaker("t-up", 2, 60))

    async def hammer_down() -> None:
        for _ in range(20):
            with contextlib.suppress(StorageUnavailable):
                await rs_down.put_stream("k", iterate(b"x"))

    async def use_up() -> float:
        start = time.perf_counter()
        for i in range(50):
            await rs_up.put_stream(f"k{i}", iterate(b"y" * 10_000))
        return time.perf_counter() - start

    _, elapsed = await asyncio.gather(hammer_down(), use_up())
    assert elapsed < 0.5
    assert rs_down.breaker.state is BreakerState.OPEN
    assert rs_up.breaker.state is BreakerState.CLOSED


@pytest.mark.asyncio
async def test_not_found_and_integrity_errors_do_not_open_breaker() -> None:
    adapter = FakeAdapter("t-nf")
    rs = ResilientStorage(adapter, CircuitBreaker("t-nf", failure_threshold=2))
    for _ in range(5):
        with pytest.raises(ObjectNotFound):
            await collect(rs.get_stream("missing"))
    assert rs.breaker.state is BreakerState.CLOSED

    class Corrupt(FakeAdapter):
        async def _get(self, key):  # noqa: ANN001, ANN202
            yield b"partial"
            raise IntegrityError("bad")

    rs2 = ResilientStorage(Corrupt("t-ie"), CircuitBreaker("t-ie", failure_threshold=2))
    for _ in range(5):
        with pytest.raises(IntegrityError):
            await collect(rs2.get_stream("k"))
    assert rs2.breaker.state is BreakerState.CLOSED
    assert sample("filegrid_storage_errors_total", storage="t-ie", operation="get", category="unknown", error_type="IntegrityError") == 5


@pytest.mark.asyncio
async def test_put_idle_timeout_ignores_slow_client_but_catches_stalled_storage() -> None:
    adapter = FakeAdapter("t-idle")
    rs = ResilientStorage(adapter, CircuitBreaker("t-idle", 5), idle_timeout=0.2)

    async def slow_client():
        for _ in range(4):
            await asyncio.sleep(0.15)  # total 0.6 s > idle timeout, but each gap is the client's
            yield b"z" * 100

    assert await rs.put_stream("slow", slow_client()) == (400, PutResult(400, adapter_hash(b"z" * 400)).sha256)

    adapter.hang_after_chunks = 100
    start = time.perf_counter()
    with pytest.raises(IdleTimeoutError):
        await rs.put_stream("stall", iterate(b"q" * 1000, 100))
    assert time.perf_counter() - start < 1.0
    assert sample("filegrid_storage_errors_total", storage="t-idle", operation="put", category="unknown", error_type="IdleTimeout") == 1
    assert rs.breaker.failures == 1


def adapter_hash(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


@pytest.mark.asyncio
async def test_get_idle_timeout_ignores_slow_consumer_but_catches_stalled_storage() -> None:
    adapter = FakeAdapter("t-gidle")
    adapter.objects["k"] = b"a" * 5000
    rs = ResilientStorage(adapter, CircuitBreaker("t-gidle", 5), idle_timeout=0.2)
    out = bytearray()
    async for chunk in rs.get_stream("k"):
        await asyncio.sleep(0.1)  # slow consumer: 5 chunks * 0.1 s > idle timeout
        out += chunk
    assert bytes(out) == b"a" * 5000

    adapter.hang_after_chunks = 2000
    with pytest.raises(IdleTimeoutError):
        await collect(rs.get_stream("k"))


@pytest.mark.asyncio
async def test_source_error_is_not_blamed_on_storage() -> None:
    adapter = FakeAdapter("t-src")
    rs = ResilientStorage(adapter, CircuitBreaker("t-src", failure_threshold=1))

    async def broken_client():
        yield b"abc"
        raise ConnectionResetError("client went away")

    with pytest.raises(ConnectionResetError):
        await rs.put_stream("k", broken_client())
    assert rs.breaker.state is BreakerState.CLOSED
    assert sample("filegrid_storage_errors_total", storage="t-src", operation="put", category="unknown", error_type="SourceError") == 1


@pytest.mark.asyncio
async def test_cancelled_trial_does_not_wedge_half_open() -> None:
    adapter = FakeAdapter("t-cancel")
    clock = FakeClock()
    rs = ResilientStorage(adapter, CircuitBreaker("t-cancel", 1, 5, clock=clock))
    rs.breaker.trip()
    clock.now += 5
    adapter.mode = "hang"
    task = asyncio.create_task(rs.put_stream("k", iterate(b"x")))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    adapter.mode = "ok"
    await rs.put_stream("k", iterate(b"x"))  # the next call becomes the trial and closes the breaker
    assert rs.breaker.state is BreakerState.CLOSED


@pytest.mark.asyncio
async def test_metrics_carry_category_and_bytes() -> None:
    adapter = FakeAdapter("t-metrics")
    rs = ResilientStorage(adapter, CircuitBreaker("t-metrics"))
    with use_category("fault_records"):
        await rs.put_stream("k", iterate(b"m" * 12_345))
        stream = rs.get_stream("k")  # category captured here
    assert current_category.get() == "unknown"
    assert await collect(stream) == b"m" * 12_345
    labels = {"storage": "t-metrics", "category": "fault_records"}
    assert sample("filegrid_storage_bytes_total", operation="put", **labels) == 12_345
    assert sample("filegrid_storage_bytes_total", operation="get", **labels) == 12_345
    assert sample("filegrid_storage_operation_seconds_count", operation="put", outcome="ok", **labels) == 1
    assert sample("filegrid_storage_operation_seconds_count", operation="get", outcome="ok", **labels) == 1


def test_category_label_sanitizes() -> None:
    assert category_label("meter_readings") == "meter_readings"
    assert category_label("Robert'); DROP") == "invalid"
    assert category_label("x" * 41) == "invalid"
    with use_category("drone_videos") as label:
        assert label == "drone_videos"
        assert category_label() == "drone_videos"
    assert category_label() == "unknown"


@pytest.mark.asyncio
async def test_early_close_of_download_is_not_an_error() -> None:
    adapter = FakeAdapter("t-early")
    adapter.objects["k"] = b"e" * 10_000
    rs = ResilientStorage(adapter, CircuitBreaker("t-early", failure_threshold=1))
    async with contextlib.aclosing(rs.get_stream("k")) as stream:
        async for _ in stream:
            break
    assert rs.breaker.state is BreakerState.CLOSED
    assert sample("filegrid_storage_errors_total", storage="t-early", operation="get", category="unknown", error_type="GeneratorExit") == 0


# ---------------------------------------------------------------- health monitor


@pytest.mark.asyncio
async def test_health_monitor_trips_and_recovers() -> None:
    adapter = FakeAdapter("t-health")
    clock = FakeClock()
    rs = ResilientStorage(adapter, CircuitBreaker("t-health", 5, 60, clock=clock), health_timeout=0.1)
    monitor = HealthMonitor([rs], interval=0.01, trip_after=2)

    await monitor.check_once()
    assert sample("filegrid_storage_up", storage="t-health") == 1

    adapter.mode = "hang"  # probe times out
    await monitor.check_once()
    assert sample("filegrid_storage_up", storage="t-health") == 0
    assert rs.breaker.state is BreakerState.CLOSED  # one failed probe is not enough
    await monitor.check_once()
    assert rs.breaker.state is BreakerState.OPEN
    with pytest.raises(CircuitOpenError):
        await rs.delete("k")

    adapter.mode = "ok"
    await monitor.check_once()
    assert sample("filegrid_storage_up", storage="t-health") == 1
    assert rs.breaker.state is BreakerState.HALF_OPEN  # recovery without waiting 60 s
    await rs.delete("k")
    assert rs.breaker.state is BreakerState.CLOSED


@pytest.mark.asyncio
async def test_health_monitor_background_task() -> None:
    adapter = FakeAdapter("t-bg")
    rs = ResilientStorage(adapter, CircuitBreaker("t-bg"), health_timeout=0.1)
    monitor = HealthMonitor([rs], interval=0.02)
    monitor.start()
    assert monitor.running
    await asyncio.sleep(0.1)
    adapter.health_ok = False
    await asyncio.sleep(0.1)
    assert rs.breaker.state is BreakerState.OPEN
    await monitor.stop()
    assert not monitor.running


@pytest.mark.asyncio
async def test_rejected_put_leaves_input_untouched_for_fallback() -> None:
    primary, fallback = FakeAdapter("t-primary"), FakeAdapter("t-fallback")
    rs_primary = ResilientStorage(primary, CircuitBreaker("t-primary"))
    rs_fallback = ResilientStorage(fallback, CircuitBreaker("t-fallback"))
    rs_primary.breaker.trip()
    chunks = iterate(b"fault record" * 1000, 1000)
    try:
        await rs_primary.put_stream("k", chunks)
    except StorageUnavailable:
        result = await rs_fallback.put_stream("k", chunks)  # same iterator, nothing lost
    assert result.size == 12_000
    assert fallback.objects["k"] == b"fault record" * 1000
