"""Shared test helpers for the storage suites.

Unit tests (no storage needed), from ``backend/``::

    python -m pytest app/storage app/crypto -m "not integration"

Integration tests against real storages are marked ``integration`` and skipped unless
``FILEGRID_INTEGRATION=1``. They read the same variables as the app (see ``app/storage/config.py``).

On a laptop, against ``make infra-up`` (Docker Compose on 127.0.0.1)::

    cd backend && set -a && . ../infra/.env && set +a
    FILEGRID_INTEGRATION=1 python -m pytest -m integration app/storage -v

In k3s (the storages are ClusterIP-only, so the tests run in a labelled pod with a 256Mi memory limit,
which is the constant-memory proof)::

    app/storage/tests/run-in-cluster.sh

Sizes of the big streaming tests in MiB (0 skips one): FILEGRID_TEST_BIG_S3_MB and FILEGRID_TEST_BIG_FTP_MB
(default FILEGRID_TEST_BIG_MB, else 1024) and FILEGRID_TEST_BIG_DB_MB (default 256). The data comes from a
generator and is never held in memory. At the end the run prints a ``MEMORY SUMMARY`` line (process peak
RSS and, in a container, the cgroup's peak and limit).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from storage_testlib import REPORT, MiB, peak_rss_bytes


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "integration: needs real S3/FTP/PostgreSQL (FILEGRID_INTEGRATION=1)")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("FILEGRID_INTEGRATION") == "1":
        return
    skip = pytest.mark.skip(reason="integration test: set FILEGRID_INTEGRATION=1 and the storage env vars")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


def _cgroup_value(name: str) -> int | None:
    try:
        raw = Path("/sys/fs/cgroup", name).read_text().strip()
    except OSError:
        return None
    return None if raw == "max" else int(raw)


def pytest_terminal_summary(terminalreporter, exitstatus, config) -> None:  # noqa: ANN001
    peak = peak_rss_bytes()
    cg_peak = _cgroup_value("memory.peak")
    cg_limit = _cgroup_value("memory.max")
    parts = [f"process_peak_rss={peak / MiB:.1f}MiB"]
    if cg_peak is not None:
        parts.append(f"cgroup_peak={cg_peak / MiB:.1f}MiB")
    if cg_limit is not None:
        parts.append(f"cgroup_limit={cg_limit / MiB:.0f}MiB")
    for line in REPORT:
        terminalreporter.write_line(line)
    terminalreporter.write_line("MEMORY SUMMARY: " + " ".join(parts))
