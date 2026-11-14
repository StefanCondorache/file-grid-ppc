"""FileGrid storage layer (P1): S3, FTP and PostgreSQL adapters behind one async streaming contract.

Modules:
    base.py        contract (``StorageAdapter``), errors, ``validate_key``, ``verify_stream``, ``HashingStream``
    registry.py    ``StorageRegistry.from_env()``: how the app gets the ``s3``/``ftp``/``db`` storages
    resilience.py  circuit breaker, timeouts, ``HealthMonitor``
    metrics.py     Prometheus metric contract and ``use_category``
    config.py      environment variables
    s3.py, ftp.py, db.py  the adapters

This file deliberately imports nothing: importing a submodule (``from app.storage.base import ...``) must
not drag in every driver, and test runners that import package ``__init__`` files under another name
cannot register the Prometheus metrics twice.

Tests, from ``backend/``: ``python -m pytest app/storage app/crypto -m "not integration"`` (unit) and
``app/storage/tests/run-in-cluster.sh`` (integration in k3s); details in ``tests/conftest.py``.
"""
