"""Circuit breaker, timeouts and health monitoring per storage (TASKS.md P1 #3).

Goal: a storage that is down fails fast and never blocks the other categories. Every adapter used by
the API is wrapped in ``ResilientStorage(adapter, CircuitBreaker(...))`` (``registry.StorageRegistry``
does this), which has the same interface as ``StorageAdapter``.

Circuit breaker (one per storage)
    CLOSED --(``failure_threshold`` consecutive failures, default 5)--> OPEN
    OPEN: every call raises ``CircuitOpenError`` (a ``StorageUnavailable``) immediately (microseconds),
    without touching the network.
    OPEN --(``reset_timeout`` elapsed, default 10 s; or a passing health probe)--> HALF_OPEN
    HALF_OPEN: exactly one trial call is let through; other calls are rejected while it runs.
    trial succeeds --> CLOSED; trial fails --> OPEN (timer restarts).
    What counts: a failure is a ``StorageUnavailable``/timeout/unexpected storage error. ``ObjectNotFound``
    and ``IntegrityError`` prove the storage answered, so they count as success. Errors from the caller's
    own input stream (client disconnected mid-upload), cancellation and ``InvalidKey`` do not count.
    A rejected ``put_stream`` (``CircuitOpenError``) has not read a single chunk of its input, so the same
    iterator can be handed straight to the policy's fallback storage. After any other failure the input
    is partly consumed: restart the upload from its source (P2: from the stored upload-session chunks).

Timeouts
    ``put``/``get`` are guarded by an inactivity timeout (``idle_timeout``, default 30 s), not by a total
    timeout: the clock only runs while the storage itself is expected to make progress. For ``put`` it is
    paused while the adapter waits for the next chunk from the caller (a slow client uploading 1 GiB over
    a bad link is fine); for ``get`` it covers the wait for each next chunk from the storage and is paused
    while the caller processes a chunk. ``delete`` has a total timeout (``op_timeout``, default 10 s) and
    ``health`` a short one (``health_timeout``, default 2 s). Connect timeouts live in the adapters.

Health monitor
    ``HealthMonitor`` polls ``health()`` of every storage every ``interval`` seconds (default 5) in a
    background task, sets ``filegrid_storage_up``, and drives the breakers: ``trip_after`` (default 2)
    consecutive failed probes open the breaker at once (and keep it open while probes keep failing, so no
    request has to wait for a connect timeout to find out); a passing probe moves an OPEN breaker to
    HALF_OPEN so the next real call can close it without waiting for ``reset_timeout``.

Metrics: see ``metrics.py`` (all recorded here, with the category from ``use_category``).
"""

from __future__ import annotations

import asyncio
import enum
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator, Callable, Iterable

from . import metrics
from .base import (
    HealthStatus,
    IntegrityError,
    InvalidKey,
    ObjectNotFound,
    PutResult,
    StorageAdapter,
    StorageError,
    StorageUnavailable,
    aclose_quietly,
    validate_key,
)

__all__ = [
    "BreakerState",
    "CircuitBreaker",
    "CircuitOpenError",
    "HealthMonitor",
    "IdleTimeoutError",
    "ResilientStorage",
]

log = logging.getLogger("filegrid.storage.resilience")


class BreakerState(enum.IntEnum):
    CLOSED = 0
    HALF_OPEN = 1
    OPEN = 2


class CircuitOpenError(StorageUnavailable):
    """Rejected without trying: the storage's circuit breaker is open."""


class IdleTimeoutError(StorageUnavailable):
    """The storage made no progress for ``idle_timeout`` seconds."""


class CircuitBreaker:
    """Consecutive-failure circuit breaker with a single-trial half-open state. Not thread-safe (asyncio)."""

    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        reset_timeout: float = 10.0,
        *,
        clock: Callable[[], float] = time.monotonic,
        on_state_change: Callable[[str, BreakerState, BreakerState], None] | None = None,
    ):
        if failure_threshold < 1:
            raise ValueError("failure_threshold must be >= 1")
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self._clock = clock
        self._on_state_change = on_state_change
        self._state = BreakerState.CLOSED
        self._failures = 0
        self._opened_at = 0.0
        self._trial_in_flight = False
        metrics.CIRCUIT_STATE.labels(storage=name).set(int(self._state))

    @property
    def state(self) -> BreakerState:
        return self._state

    @property
    def failures(self) -> int:
        return self._failures

    def _set(self, state: BreakerState) -> None:
        old, self._state = self._state, state
        if old is state:
            return
        metrics.CIRCUIT_STATE.labels(storage=self.name).set(int(state))
        log.warning("storage %s: circuit %s -> %s", self.name, old.name, state.name)
        if self._on_state_change is not None:
            self._on_state_change(self.name, old, state)

    def before_call(self) -> bool:
        """Admit a call or raise ``CircuitOpenError``. Returns True if the call is the half-open trial."""
        if self._state is BreakerState.OPEN:
            if self._clock() - self._opened_at < self.reset_timeout:
                raise CircuitOpenError(f"{self.name}: circuit open")
            self._set(BreakerState.HALF_OPEN)
        if self._state is BreakerState.HALF_OPEN:
            if self._trial_in_flight:
                raise CircuitOpenError(f"{self.name}: circuit half-open, trial call in progress")
            self._trial_in_flight = True
            return True
        return False

    def record_success(self, trial: bool = False) -> None:
        if trial:
            self._trial_in_flight = False
        if self._state is BreakerState.OPEN and not trial:
            return  # a call admitted before the breaker opened proves little; wait for the trial
        self._failures = 0
        self._set(BreakerState.CLOSED)

    def record_failure(self, trial: bool = False) -> None:
        if trial:
            self._trial_in_flight = False
        if self._state is BreakerState.HALF_OPEN or trial:
            self._open()
            return
        if self._state is BreakerState.CLOSED:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._open()

    def record_ignored(self, trial: bool = False) -> None:
        """The call ended without telling anything about the storage (cancelled, caller's input failed)."""
        if trial:
            self._trial_in_flight = False

    def trip(self) -> None:
        """Open now (or keep open and restart the timer): used when health probes fail."""
        self._open()

    def allow_trial(self) -> None:
        """OPEN -> HALF_OPEN now (a health probe passed): the next call is the trial."""
        if self._state is BreakerState.OPEN:
            self._set(BreakerState.HALF_OPEN)

    def _open(self) -> None:
        self._opened_at = self._clock()
        self._failures = 0
        self._set(BreakerState.OPEN)


def _error_type(exc: BaseException) -> str:
    if isinstance(exc, CircuitOpenError):
        return "CircuitOpen"
    if isinstance(exc, IdleTimeoutError):
        return "IdleTimeout"
    if isinstance(exc, (ObjectNotFound, IntegrityError, InvalidKey)):
        return type(exc).__name__
    if isinstance(exc, StorageError) and exc.__cause__ is not None:
        return type(exc.__cause__).__name__
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return "Timeout"
    return type(exc).__name__


def _counts_as_success(exc: BaseException) -> bool:
    return isinstance(exc, (ObjectNotFound, IntegrityError))


class _Op:
    """Records one operation's metrics: duration, outcome, errors."""

    __slots__ = ("storage", "operation", "category", "start")

    def __init__(self, storage: str, operation: str, category: str):
        self.storage, self.operation, self.category = storage, operation, category
        self.start = time.perf_counter()

    def _observe(self, outcome: str) -> None:
        metrics.OPERATION_SECONDS.labels(self.storage, self.operation, self.category, outcome).observe(
            time.perf_counter() - self.start
        )

    def ok(self) -> None:
        self._observe("ok")

    def error(self, exc: BaseException, error_type: str | None = None) -> None:
        outcome = "rejected" if isinstance(exc, CircuitOpenError) else "error"
        self._observe(outcome)
        metrics.ERRORS_TOTAL.labels(
            self.storage, self.operation, self.category, error_type or _error_type(exc)
        ).inc()

    def add_bytes(self, n: int) -> None:
        metrics.BYTES_TOTAL.labels(self.storage, self.operation, self.category).inc(n)


class _SourceError(Exception):
    """Internal marker: the caller's input stream raised (wrapped so it is not blamed on the storage)."""


class _GuardedSource:
    """Wraps the caller's chunks for ``put``: pauses the idle deadline while waiting for the caller,
    re-arms it when a chunk is handed to the adapter, counts bytes, and remembers caller-side errors."""

    def __init__(self, source: AsyncIterable[bytes], op: _Op, idle_timeout: float):
        self._source = source
        self._op = op
        self._idle = idle_timeout
        self.timeout: asyncio.Timeout | None = None
        self.error: BaseException | None = None

    def _arm(self, deadline: float | None) -> None:
        if self.timeout is not None and not self.timeout.expired():
            self.timeout.reschedule(deadline)

    async def __call__(self) -> AsyncIterator[bytes]:
        loop = asyncio.get_running_loop()
        it = aiter(self._source)
        try:
            while True:
                self._arm(None)
                try:
                    chunk = await anext(it)
                except StopAsyncIteration:
                    return
                except Exception as exc:
                    # Wrapped so the adapter cannot mistake it for its own I/O error (e.g. a client's
                    # ConnectionResetError looking like "storage unavailable"); unwrapped by ResilientStorage.
                    self.error = exc
                    raise _SourceError(str(exc)) from exc
                finally:
                    self._arm(loop.time() + self._idle)
                if chunk:
                    self._op.add_bytes(len(chunk))
                yield chunk
        finally:
            await aclose_quietly(it)


class ResilientStorage(StorageAdapter):
    """Wraps an adapter with a circuit breaker, timeouts and metrics; same interface as the adapter."""

    def __init__(
        self,
        adapter: StorageAdapter,
        breaker: CircuitBreaker | None = None,
        *,
        idle_timeout: float = 30.0,
        op_timeout: float = 10.0,
        health_timeout: float = 2.0,
    ):
        self.adapter = adapter
        self.name = adapter.name
        self.breaker = breaker or CircuitBreaker(adapter.name)
        self.idle_timeout = idle_timeout
        self.op_timeout = op_timeout
        self.health_timeout = health_timeout
        self.last_health: HealthStatus | None = None
        self._health_failures = 0

    def _admit(self, op: _Op) -> bool:
        try:
            return self.breaker.before_call()
        except CircuitOpenError as exc:
            op.error(exc)
            raise

    def _settle(self, op: _Op, trial: bool, exc: BaseException | None, *, source_error: bool = False) -> None:
        if exc is None:
            self.breaker.record_success(trial)
            op.ok()
        elif isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
            self.breaker.record_ignored(trial)
        elif source_error:
            self.breaker.record_ignored(trial)
            op.error(exc, "SourceError")
        elif _counts_as_success(exc):
            self.breaker.record_success(trial)
            op.error(exc)
        else:
            self.breaker.record_failure(trial)
            op.error(exc)

    async def put_stream(self, key: str, chunks: AsyncIterable[bytes]) -> PutResult:
        validate_key(key)
        op = _Op(self.name, "put", metrics.category_label())
        trial = self._admit(op)
        guard = _GuardedSource(chunks, op, self.idle_timeout)
        try:
            async with asyncio.timeout(self.idle_timeout) as timeout:
                guard.timeout = timeout
                result = await self.adapter.put_stream(key, guard())
        except BaseException as exc:
            if guard.error is not None and not isinstance(exc, asyncio.CancelledError):
                # The caller's input failed (e.g. client disconnected): not the storage's fault.
                self._settle(op, trial, guard.error, source_error=True)
                raise guard.error from None
            if isinstance(exc, TimeoutError) and timeout.expired():
                err = IdleTimeoutError(f"{self.name}: no progress for {self.idle_timeout:g}s during put")
                self._settle(op, trial, err)
                raise err from exc
            self._settle(op, trial, exc)
            raise
        self._settle(op, trial, None)
        return result

    def get_stream(self, key: str) -> AsyncIterator[bytes]:
        validate_key(key)
        # The category is captured now, not when the caller starts iterating.
        return self._get(key, metrics.category_label())

    async def _get(self, key: str, category: str) -> AsyncIterator[bytes]:
        op = _Op(self.name, "get", category)
        trial = self._admit(op)
        it = aiter(self.adapter.get_stream(key))
        received = 0
        try:
            while True:
                try:
                    async with asyncio.timeout(self.idle_timeout) as timeout:
                        chunk = await anext(it)
                except StopAsyncIteration:
                    break
                except TimeoutError as exc:
                    if timeout.expired():
                        raise IdleTimeoutError(
                            f"{self.name}: no data for {self.idle_timeout:g}s during get"
                        ) from exc
                    raise
                if chunk:
                    received += len(chunk)
                    op.add_bytes(len(chunk))
                yield chunk
        except GeneratorExit:
            # The consumer stopped early: not the storage's fault. Data flowed => the storage works.
            if received:
                self.breaker.record_success(trial)
            else:
                self.breaker.record_ignored(trial)
            raise
        except BaseException as exc:
            self._settle(op, trial, exc)
            raise
        finally:
            await aclose_quietly(it)
        self._settle(op, trial, None)

    async def delete(self, key: str) -> None:
        validate_key(key)
        op = _Op(self.name, "delete", metrics.category_label())
        trial = self._admit(op)
        try:
            async with asyncio.timeout(self.op_timeout):
                await self.adapter.delete(key)
        except TimeoutError as exc:
            err = StorageUnavailable(f"{self.name}: delete timed out after {self.op_timeout:g}s")
            self._settle(op, trial, err)
            raise err from exc
        except BaseException as exc:
            self._settle(op, trial, exc)
            raise
        self._settle(op, trial, None)

    async def health(self) -> HealthStatus:
        """Probe the storage directly (bypasses the breaker so an open breaker can still see recovery)."""
        op = _Op(self.name, "health", "system")
        try:
            async with asyncio.timeout(self.health_timeout):
                status = await self.adapter.health()
        except TimeoutError:
            status = HealthStatus(False, self.health_timeout * 1000, f"health probe timed out after {self.health_timeout:g}s")
        except Exception as exc:  # noqa: BLE001 - adapters should not raise here, but never crash the monitor
            status = HealthStatus(False, (time.perf_counter() - op.start) * 1000, f"health probe failed: {type(exc).__name__}")
        if status.ok:
            op.ok()
        else:
            op.error(StorageUnavailable(status.detail), "HealthCheckFailed")
        metrics.STORAGE_UP.labels(storage=self.name).set(1 if status.ok else 0)
        self.last_health = status
        return status

    async def check_health(self, trip_after: int = 2) -> HealthStatus:
        """Run one probe and feed the result to the breaker (used by ``HealthMonitor``)."""
        status = await self.health()
        if status.ok:
            self._health_failures = 0
            self.breaker.allow_trial()
        else:
            self._health_failures += 1
            if self._health_failures >= trip_after:
                self.breaker.trip()
        return status

    async def aclose(self) -> None:
        await self.adapter.aclose()


class HealthMonitor:
    """Background task polling every storage's health; see the module docstring."""

    def __init__(self, storages: Iterable[ResilientStorage], interval: float = 5.0, trip_after: int = 2):
        self.storages = list(storages)
        self.interval = interval
        self.trip_after = trip_after
        self._task: asyncio.Task | None = None

    async def check_once(self) -> dict[str, HealthStatus]:
        results = await asyncio.gather(*(s.check_health(self.trip_after) for s in self.storages))
        return {s.name: r for s, r in zip(self.storages, results, strict=True)}

    async def _run(self) -> None:
        while True:
            try:
                await self.check_once()
            except Exception:  # noqa: BLE001 - keep monitoring whatever happens
                log.exception("health monitor iteration failed")
            await asyncio.sleep(self.interval)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="filegrid-storage-health")

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
