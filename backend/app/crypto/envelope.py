"""Streamed envelope encryption (AES-256-GCM) for connection documents, which contain personal data.

Why: someone who reads a storage directly (a leaked S3 key, a copied FTP directory, a DB dump) must not
see the documents. The backend encrypts before the bytes reach any storage adapter and decrypts after
reading, so every storage only ever holds ciphertext.

Scheme (format ``FGE1`` version 1)
    * A fresh random 256-bit data key (DEK) per object.
    * The DEK is wrapped with AES-256-GCM under the KEK (``keys.py``); the wrap's associated data binds
      it to the magic, version and key id.
    * The plaintext is cut into 64 KiB segments. Segment ``i`` is sealed with AES-256-GCM under the DEK,
      nonce = 7-byte random prefix || ``i`` as 4-byte big-endian || last-flag byte (1 on the final
      segment, else 0), associated data = the whole header. This is the "STREAM" construction (Hoang,
      Reyhanitabar, Rogaway, Vizár 2015): each segment is authenticated on its own (constant memory,
      nothing unverified is ever released), and the counter and last flag make reordering, dropping,
      truncating or appending segments detectable.

Layout::

    header  = "FGE1" | version(1)=0x01 | key_id_len(1) | key_id | wrap_nonce(12) | wrapped_dek(32+16)
              | nonce_prefix(7)
    body    = segment_0 | segment_1 | ... | segment_last
    segment = AES-256-GCM(DEK, nonce_i, plaintext_i (64 KiB; the last one 0..64 KiB), aad=header)
              -> ciphertext_i | tag_i(16)

Overhead: 73 + len(key_id) bytes of header plus 16 bytes per 64 KiB (0.02 %).

API (constant memory, both take ownership of and close their input iterator)::

    from app.crypto import Keyring, decrypt_stream, encrypt_stream
    keyring = Keyring.from_env()
    size, sha256 = await storage.put_stream(key, encrypt_stream(chunks, keyring.primary))
    async for plain in decrypt_stream(verify_stream(storage.get_stream(key), sha256), keyring):
        ...

``decrypt_stream`` raises ``DecryptionError`` on a wrong key, an unknown key id, any modified byte, a
truncated or extended object, or reordered segments. It verifies each segment before yielding it, but a
truncation is only detectable at the end, after earlier (authentic) segments were yielded: a consumer
that streams to a client must abort the response on this exception rather than end it normally.
The ``sha256`` returned by ``put_stream`` is the hash of the ciphertext (what the storage holds); hash
the plaintext separately (``HashingStream`` before ``encrypt_stream``) if you need it for audit.
"""

from __future__ import annotations

import secrets
import struct
from collections.abc import AsyncIterable, AsyncIterator

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .keys import KEY_BYTES, Kek, Keyring

__all__ = [
    "MAGIC",
    "SEGMENT_SIZE",
    "TAG_SIZE",
    "CryptoError",
    "DecryptionError",
    "decrypt_stream",
    "encrypt_stream",
    "is_encrypted_prefix",
]

MAGIC = b"FGE1"
VERSION = 1
SEGMENT_SIZE = 64 * 1024
TAG_SIZE = 16
NONCE_PREFIX_SIZE = 7
WRAP_NONCE_SIZE = 12
WRAPPED_DEK_SIZE = KEY_BYTES + TAG_SIZE
MAX_SEGMENTS = 2**32  # counter is 4 bytes: 2^32 * 64 KiB = 256 TiB per object


class CryptoError(Exception):
    """Base class for encryption errors."""


class DecryptionError(CryptoError):
    """The ciphertext is not authentic for any available key (tampered, truncated, wrong key...)."""


def _nonce(prefix: bytes, counter: int, last: bool) -> bytes:
    if counter >= MAX_SEGMENTS:
        raise CryptoError("object too large for one encryption stream")
    return prefix + struct.pack(">IB", counter, 1 if last else 0)


def _wrap_aad(key_id: bytes) -> bytes:
    return MAGIC + bytes((VERSION, len(key_id))) + key_id


def is_encrypted_prefix(data: bytes) -> bool:
    """True if ``data`` starts like an FGE1 object (a cheap check, not a proof of authenticity)."""
    return data[:5] == MAGIC + bytes((VERSION,))


async def _aclose(it: object) -> None:
    aclose = getattr(it, "aclose", None)
    if aclose is not None:
        try:
            await aclose()
        except Exception:  # noqa: BLE001
            pass


async def encrypt_stream(chunks: AsyncIterable[bytes], kek: Kek) -> AsyncIterator[bytes]:
    """Encrypt an async byte stream under a fresh DEK wrapped by ``kek``; yields header then segments."""
    if not isinstance(kek, Kek):
        raise TypeError("kek must be an app.crypto.Kek")
    dek = AESGCM.generate_key(bit_length=256)
    key_id = kek.key_id.encode("ascii")
    wrap_nonce = secrets.token_bytes(WRAP_NONCE_SIZE)
    wrapped = AESGCM(kek.key).encrypt(wrap_nonce, dek, _wrap_aad(key_id))
    prefix = secrets.token_bytes(NONCE_PREFIX_SIZE)
    header = _wrap_aad(key_id) + wrap_nonce + wrapped + prefix
    aead = AESGCM(dek)
    del dek

    counter = 0
    buf = bytearray()
    source = aiter(chunks)
    try:
        yield header
        async for chunk in source:
            if not chunk:
                continue
            buf += chunk
            # Seal only segments that are known not to be the last one (more bytes follow them).
            if len(buf) <= SEGMENT_SIZE:
                continue
            ready = (len(buf) - 1) // SEGMENT_SIZE * SEGMENT_SIZE
            for off in range(0, ready, SEGMENT_SIZE):
                with memoryview(buf) as view:
                    segment = bytes(view[off : off + SEGMENT_SIZE])
                sealed = aead.encrypt(_nonce(prefix, counter, False), segment, header)
                counter += 1
                yield sealed
            del buf[:ready]
        yield aead.encrypt(_nonce(prefix, counter, True), bytes(buf), header)
    finally:
        await _aclose(source)


class _Reader:
    """Pull exact byte counts out of an async chunk stream with a bounded buffer.

    Consumed bytes are tracked with an offset and compacted once per input chunk, so large input chunks
    (e.g. 1 MiB blocks from S3) do not cause one memmove per 64 KiB segment.
    """

    def __init__(self, source: AsyncIterable[bytes]):
        self._it = aiter(source)
        self._buf = bytearray()
        self._off = 0
        self._eof = False

    def _available(self) -> int:
        return len(self._buf) - self._off

    async def _fill(self, n: int) -> None:
        while self._available() < n and not self._eof:
            try:
                chunk = await anext(self._it)
            except StopAsyncIteration:
                self._eof = True
                return
            if self._off:
                del self._buf[: self._off]
                self._off = 0
            self._buf += chunk

    def _take(self, n: int) -> bytes:
        n = min(n, self._available())
        with memoryview(self._buf) as view:
            out = bytes(view[self._off : self._off + n])
        self._off += n
        return out

    async def read_exact(self, n: int) -> bytes:
        await self._fill(n)
        if self._available() < n:
            raise DecryptionError("truncated header")
        return self._take(n)

    async def read_upto(self, n: int) -> tuple[bytes, bool]:
        """Return up to ``n`` bytes and whether more data follows them."""
        await self._fill(n + 1)
        out = self._take(n)
        return out, self._available() > 0

    async def aclose(self) -> None:
        await _aclose(self._it)


async def decrypt_stream(chunks: AsyncIterable[bytes], keyring: Keyring | Kek) -> AsyncIterator[bytes]:
    """Decrypt an FGE1 stream; yields plaintext one verified 64 KiB segment at a time."""
    if isinstance(keyring, Kek):
        keyring = Keyring(keyring)
    reader = _Reader(chunks)
    try:
        fixed = await reader.read_exact(6)
        if fixed[:4] != MAGIC:
            raise DecryptionError("not an FGE1 object")
        if fixed[4] != VERSION:
            raise DecryptionError(f"unsupported FGE version {fixed[4]}")
        key_id_len = fixed[5]
        if not 1 <= key_id_len <= 64:
            raise DecryptionError("invalid key id length")
        rest = await reader.read_exact(key_id_len + WRAP_NONCE_SIZE + WRAPPED_DEK_SIZE + NONCE_PREFIX_SIZE)
        key_id = rest[:key_id_len]
        wrap_nonce = rest[key_id_len : key_id_len + WRAP_NONCE_SIZE]
        wrapped = rest[key_id_len + WRAP_NONCE_SIZE : key_id_len + WRAP_NONCE_SIZE + WRAPPED_DEK_SIZE]
        prefix = rest[-NONCE_PREFIX_SIZE:]
        header = fixed + rest

        kek = keyring.get(key_id.decode("ascii", errors="replace"))
        if kek is None:
            raise DecryptionError("object was encrypted with a key id that is not configured")
        try:
            dek = AESGCM(kek.key).decrypt(wrap_nonce, wrapped, _wrap_aad(key_id))
        except InvalidTag:
            raise DecryptionError("cannot unwrap the data key: wrong KEK or tampered header") from None
        aead = AESGCM(dek)
        del dek

        counter = 0
        while True:
            sealed, more = await reader.read_upto(SEGMENT_SIZE + TAG_SIZE)
            if len(sealed) < TAG_SIZE:
                raise DecryptionError("truncated ciphertext")
            if more and len(sealed) != SEGMENT_SIZE + TAG_SIZE:  # pragma: no cover - read_upto guarantees it
                raise DecryptionError("malformed segment")
            try:
                plain = aead.decrypt(_nonce(prefix, counter, not more), sealed, header)
            except InvalidTag:
                raise DecryptionError(
                    f"segment {counter} failed authentication (tampered, reordered, truncated or extended)"
                ) from None
            counter += 1
            if plain:
                yield plain
            if not more:
                return
    finally:
        await reader.aclose()
