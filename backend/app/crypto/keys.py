"""Key-encryption keys (KEK) for envelope encryption of connection documents.

The KEK never lives in the repository. It comes from the environment (in k3s: a Secret mounted with
``envFrom``; on laptops: ``infra/.env``, generated and git-ignored):

    FILEGRID_KEK           base64 of 32 random bytes (AES-256). Required to encrypt or decrypt.
    FILEGRID_KEK_ID        short id stored in every encrypted object's header, default ``k1``.
                           Charset ``[A-Za-z0-9._-]``, 1..64 chars.
    FILEGRID_KEK_RETIRED   optional, for key rotation: ``id:base64,id:base64``. Retired keys only decrypt.

Rotation: generate a new key, move the old ``id:key`` into FILEGRID_KEK_RETIRED, set the new key and a
new id. Old objects still decrypt (their header names the old id); new objects use the new key.

Generate a key (prints it to stdout, only because you asked)::

    python -m app.crypto.keys gen

Check the configured keys without printing them::

    python -m app.crypto.keys check

Key material is never logged, never part of an exception message, and hidden from ``repr``.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
import secrets
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

__all__ = ["KEY_BYTES", "Kek", "KeyConfigError", "Keyring", "generate_kek_b64"]

KEY_BYTES = 32
_KEY_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,64}")


class KeyConfigError(ValueError):
    """Missing or malformed key configuration (messages never contain key material)."""


def _decode_key(value: str, what: str) -> bytes:
    value = value.strip()
    try:
        padded = value + "=" * (-len(value) % 4)
        raw = base64.b64decode(padded.replace("-", "+").replace("_", "/"), validate=True)
    except (binascii.Error, ValueError):
        raise KeyConfigError(f"{what} is not valid base64") from None
    if len(raw) != KEY_BYTES:
        raise KeyConfigError(f"{what} must decode to {KEY_BYTES} bytes, got {len(raw)}")
    return raw


def _check_id(key_id: str) -> str:
    if not _KEY_ID_RE.fullmatch(key_id or ""):
        raise KeyConfigError("key id must match [A-Za-z0-9._-]{1,64}")
    return key_id


@dataclass(frozen=True)
class Kek:
    """A named 256-bit key-encryption key."""

    key_id: str
    key: bytes = field(repr=False)

    def __post_init__(self) -> None:
        _check_id(self.key_id)
        if not isinstance(self.key, bytes) or len(self.key) != KEY_BYTES:
            raise KeyConfigError(f"KEK must be {KEY_BYTES} bytes")

    @classmethod
    def generate(cls, key_id: str = "k1") -> Kek:
        return cls(key_id, secrets.token_bytes(KEY_BYTES))

    @classmethod
    def from_b64(cls, key_id: str, value: str) -> Kek:
        return cls(_check_id(key_id), _decode_key(value, f"key {key_id!r}"))

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Kek:
        value = env.get("FILEGRID_KEK", "")
        if not value:
            raise KeyConfigError("FILEGRID_KEK is not set")
        return cls(_check_id(env.get("FILEGRID_KEK_ID") or "k1"), _decode_key(value, "FILEGRID_KEK"))


class Keyring:
    """Keys available for decryption, by id; ``primary`` is the one used to encrypt."""

    def __init__(self, primary: Kek, retired: Iterable[Kek] = ()):
        self.primary = primary
        self._keys: dict[str, Kek] = {}
        for kek in (*retired, primary):
            self._keys[kek.key_id] = kek

    def __repr__(self) -> str:
        return f"Keyring(primary={self.primary.key_id!r}, ids={sorted(self._keys)!r})"

    @property
    def ids(self) -> list[str]:
        return sorted(self._keys)

    def get(self, key_id: str) -> Kek | None:
        return self._keys.get(key_id)

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> Keyring:
        primary = Kek.from_env(env)
        retired = []
        for item in filter(None, (s.strip() for s in env.get("FILEGRID_KEK_RETIRED", "").split(","))):
            key_id, sep, value = item.partition(":")
            if not sep:
                raise KeyConfigError("FILEGRID_KEK_RETIRED entries must look like id:base64")
            retired.append(Kek.from_b64(key_id.strip(), value))
        return cls(primary, retired)


def generate_kek_b64() -> str:
    """A new random KEK, base64 encoded (standard alphabet, padded)."""
    return base64.b64encode(secrets.token_bytes(KEY_BYTES)).decode("ascii")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args == ["gen"]:
        print(generate_kek_b64())
        return 0
    if args == ["check"]:
        try:
            ring = Keyring.from_env()
        except KeyConfigError as exc:
            print(f"invalid key configuration: {exc}", file=sys.stderr)
            return 1
        print(f"ok: primary key id {ring.primary.key_id!r}, {len(ring.ids)} key(s) loaded")
        return 0
    print("usage: python -m app.crypto.keys gen|check", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
