"""Unit tests for streamed envelope encryption (format FGE1) and key configuration."""

from __future__ import annotations

import base64
import os
import struct

import pytest
import pytest_asyncio

from app.crypto import (
    SEGMENT_SIZE,
    DecryptionError,
    Kek,
    KeyConfigError,
    Keyring,
    decrypt_stream,
    encrypt_stream,
    generate_kek_b64,
    is_encrypted_prefix,
)
from app.crypto import keys as keys_module

MiB = 1024 * 1024
TAG = 16
SEALED = SEGMENT_SIZE + TAG


async def pieces(data: bytes, size: int = 10_000):
    for off in range(0, len(data), size):
        yield data[off : off + size]


async def encrypt(data: bytes, kek: Kek, piece: int = 10_000) -> bytes:
    return b"".join([c async for c in encrypt_stream(pieces(data, piece), kek)])


async def decrypt(blob: bytes, keyring, piece: int = 7_777) -> bytes:  # noqa: ANN001
    return b"".join([c async for c in decrypt_stream(pieces(blob, piece), keyring)])


def header_len(kek: Kek) -> int:
    return 4 + 1 + 1 + len(kek.key_id) + 12 + 48 + 7


@pytest.fixture
def kek() -> Kek:
    return Kek.generate("k1")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "size", [0, 1, SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 1, 2 * SEGMENT_SIZE, 10 * MiB]
)
@pytest.mark.parametrize("piece", [1_000, 65_536, 1_000_000])
async def test_round_trip(kek: Kek, size: int, piece: int) -> None:
    if size == 10 * MiB and piece == 1_000:
        pytest.skip("covered by the larger pieces; 10k tiny chunks only slow the suite")
    data = os.urandom(size)
    blob = await encrypt(data, kek, piece)
    segments = max(1, -(-size // SEGMENT_SIZE))
    assert len(blob) == header_len(kek) + size + segments * TAG
    assert is_encrypted_prefix(blob)
    assert await decrypt(blob, Keyring(kek), piece) == data


@pytest.mark.asyncio
async def test_each_object_gets_a_fresh_data_key_and_nonce(kek: Kek) -> None:
    data = b"same plaintext" * 1000
    a, b = await encrypt(data, kek), await encrypt(data, kek)
    assert a != b
    assert a[header_len(kek) :] != b[header_len(kek) :]


@pytest.mark.asyncio
async def test_ciphertext_does_not_contain_the_plaintext(kek: Kek) -> None:
    """The raw object in a storage cannot be read: no plaintext fragment survives encryption."""
    marker = b"CNP 1850101223344 - Ion Popescu, str. Exemplu 1, Constanta"
    data = (marker + b"\n") * 20_000  # ~1.2 MiB of personal-data-like text
    blob = await encrypt(data, kek)
    assert marker not in blob
    for word in (b"Popescu", b"1850101223344", b"Constanta"):
        assert word not in blob
    # ciphertext looks random: no byte value dominates (plaintext is ASCII-only)
    body = blob[header_len(kek) :]
    assert max(body.count(bytes([v])) for v in range(256)) < len(body) / 128


async def tampered(blob: bytes, kek: Kek) -> None:
    await decrypt(blob, Keyring(kek))


@pytest_asyncio.fixture
async def three_segments(kek: Kek) -> tuple[bytes, bytes]:
    data = os.urandom(2 * SEGMENT_SIZE + 1000)
    return data, await encrypt(data, kek)


@pytest.mark.asyncio
@pytest.mark.parametrize("where", ["header_magic", "header_key_id", "wrapped_dek", "nonce_prefix", "segment_0", "segment_last", "tag"])
async def test_any_flipped_bit_is_rejected(kek: Kek, three_segments, where: str) -> None:  # noqa: ANN001
    _, blob = three_segments
    h = header_len(kek)
    offsets = {
        "header_magic": 0,
        "header_key_id": 6,
        "wrapped_dek": 6 + len(kek.key_id) + 12 + 5,
        "nonce_prefix": h - 3,
        "segment_0": h + 10,
        "segment_last": len(blob) - TAG - 5,
        "tag": len(blob) - 1,
    }
    broken = bytearray(blob)
    broken[offsets[where]] ^= 0x01
    with pytest.raises(DecryptionError):
        await tampered(bytes(broken), kek)


@pytest.mark.asyncio
async def test_truncation_dropping_last_segment_is_rejected(kek: Kek, three_segments) -> None:  # noqa: ANN001
    _, blob = three_segments
    h = header_len(kek)
    without_last = blob[: h + 2 * SEALED]  # ends exactly on a segment boundary
    with pytest.raises(DecryptionError):
        await tampered(without_last, kek)


@pytest.mark.asyncio
@pytest.mark.parametrize("cut", [1, TAG, TAG + 1, 1000])
async def test_truncation_inside_a_segment_is_rejected(kek: Kek, three_segments, cut: int) -> None:  # noqa: ANN001
    _, blob = three_segments
    with pytest.raises(DecryptionError):
        await tampered(blob[:-cut], kek)


@pytest.mark.asyncio
async def test_truncation_to_header_only_is_rejected(kek: Kek, three_segments) -> None:  # noqa: ANN001
    _, blob = three_segments
    with pytest.raises(DecryptionError, match="truncated"):
        await tampered(blob[: header_len(kek)], kek)
    with pytest.raises(DecryptionError, match="truncated"):
        await tampered(blob[:20], kek)
    with pytest.raises(DecryptionError, match="truncated"):
        await tampered(b"", kek)


@pytest.mark.asyncio
async def test_empty_plaintext_truncation_is_rejected(kek: Kek) -> None:
    blob = await encrypt(b"", kek)
    assert await decrypt(blob, Keyring(kek)) == b""
    with pytest.raises(DecryptionError):
        await tampered(blob[:-1], kek)


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [b"\0", b"x" * TAG, b"y" * SEALED])
async def test_appended_data_is_rejected(kek: Kek, three_segments, extra: bytes) -> None:  # noqa: ANN001
    _, blob = three_segments
    with pytest.raises(DecryptionError):
        await tampered(blob + extra, kek)


@pytest.mark.asyncio
async def test_reordered_segments_are_rejected(kek: Kek, three_segments) -> None:  # noqa: ANN001
    _, blob = three_segments
    h = header_len(kek)
    s0, s1, rest = blob[h : h + SEALED], blob[h + SEALED : h + 2 * SEALED], blob[h + 2 * SEALED :]
    with pytest.raises(DecryptionError):
        await tampered(blob[:h] + s1 + s0 + rest, kek)


@pytest.mark.asyncio
async def test_duplicated_segment_is_rejected(kek: Kek, three_segments) -> None:  # noqa: ANN001
    _, blob = three_segments
    h = header_len(kek)
    s0 = blob[h : h + SEALED]
    with pytest.raises(DecryptionError):
        await tampered(blob[:h] + s0 + blob[h:], kek)


@pytest.mark.asyncio
async def test_segment_spliced_from_another_object_is_rejected(kek: Kek) -> None:
    data = os.urandom(3 * SEGMENT_SIZE)
    a, b = await encrypt(data, kek), await encrypt(data, kek)
    h = header_len(kek)
    spliced = a[: h + SEALED] + b[h + SEALED : h + 2 * SEALED] + a[h + 2 * SEALED :]
    with pytest.raises(DecryptionError):
        await tampered(spliced, kek)


@pytest.mark.asyncio
async def test_header_swapped_between_objects_is_rejected(kek: Kek) -> None:
    a, b = await encrypt(b"a" * 1000, kek), await encrypt(b"b" * 1000, kek)
    h = header_len(kek)
    with pytest.raises(DecryptionError):
        await tampered(a[:h] + b[h:], kek)


@pytest.mark.asyncio
async def test_wrong_kek_fails(kek: Kek) -> None:
    blob = await encrypt(b"secret document" * 100, kek)
    other = Kek.generate("k1")  # same id, different key material
    with pytest.raises(DecryptionError, match="wrong KEK"):
        await decrypt(blob, Keyring(other))


@pytest.mark.asyncio
async def test_unknown_key_id_fails(kek: Kek) -> None:
    blob = await encrypt(b"x", kek)
    with pytest.raises(DecryptionError, match="key id"):
        await decrypt(blob, Keyring(Kek.generate("k2")))


@pytest.mark.asyncio
async def test_not_fge_or_unknown_version(kek: Kek) -> None:
    with pytest.raises(DecryptionError, match="not an FGE1"):
        await decrypt(b"PK\x03\x04" + b"\0" * 200, Keyring(kek))
    blob = bytearray(await encrypt(b"x", kek))
    blob[4] = 2
    with pytest.raises(DecryptionError, match="version"):
        await decrypt(bytes(blob), Keyring(kek))


@pytest.mark.asyncio
async def test_key_rotation_old_objects_still_decrypt() -> None:
    old, new = Kek.generate("2026-01"), Kek.generate("2026-11")
    blob_old = await encrypt(b"old doc", old)
    blob_new = await encrypt(b"new doc", new)
    ring = Keyring(new, retired=[old])
    assert ring.primary.key_id == "2026-11"
    assert await decrypt(blob_old, ring) == b"old doc"
    assert await decrypt(blob_new, ring) == b"new doc"


@pytest.mark.asyncio
async def test_decrypt_accepts_a_single_kek(kek: Kek) -> None:
    assert await decrypt(await encrypt(b"abc", kek), kek) == b"abc"


@pytest.mark.asyncio
async def test_decrypt_never_yields_unverified_plaintext(kek: Kek) -> None:
    data = os.urandom(3 * SEGMENT_SIZE)
    blob = bytearray(await encrypt(data, kek))
    h = header_len(kek)
    blob[h + SEALED + 100] ^= 0x80  # corrupt segment 1
    out = bytearray()
    with pytest.raises(DecryptionError, match="segment 1"):
        async for chunk in decrypt_stream(pieces(bytes(blob)), Keyring(kek)):
            out += chunk
    assert bytes(out) == data[:SEGMENT_SIZE]  # only the authentic segment 0 was released


@pytest.mark.asyncio
async def test_streams_close_their_source(kek: Kek) -> None:
    closed = []

    async def source(tag: str, data: bytes):
        try:
            for off in range(0, len(data), 1000):
                yield data[off : off + 1000]
        finally:
            closed.append(tag)

    enc = encrypt_stream(source("enc", os.urandom(200_000)), kek)
    await anext(enc)  # header
    await anext(enc)  # first segment: the source is now running
    await enc.aclose()
    blob = await encrypt(os.urandom(200_000), kek)
    dec = decrypt_stream(source("dec", blob), Keyring(kek))
    await anext(dec)
    await dec.aclose()
    assert closed == ["enc", "dec"]


def test_nonce_layout_counter_and_last_flag() -> None:
    from app.crypto.envelope import _nonce

    n = _nonce(b"\xaa" * 7, 5, True)
    assert len(n) == 12
    assert n[:7] == b"\xaa" * 7
    assert struct.unpack(">IB", n[7:]) == (5, 1)
    assert _nonce(b"\0" * 7, 5, False)[-1] == 0


# ---------------------------------------------------------------- keys


def test_kek_from_env_and_repr_hides_key() -> None:
    raw = os.urandom(32)
    b64 = base64.b64encode(raw).decode()
    kek = Kek.from_env({"FILEGRID_KEK": b64, "FILEGRID_KEK_ID": "prod-1"})
    assert kek.key == raw and kek.key_id == "prod-1"
    assert b64 not in repr(kek) and raw.hex() not in repr(kek)
    assert Kek.from_env({"FILEGRID_KEK": b64}).key_id == "k1"
    urlsafe = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    assert Kek.from_env({"FILEGRID_KEK": urlsafe}).key == raw


@pytest.mark.parametrize(
    "env,match",
    [
        ({}, "not set"),
        ({"FILEGRID_KEK": "not base64!!"}, "base64"),
        ({"FILEGRID_KEK": base64.b64encode(b"short").decode()}, "32 bytes"),
        ({"FILEGRID_KEK": base64.b64encode(b"k" * 32).decode(), "FILEGRID_KEK_ID": "bad id"}, "key id"),
    ],
)
def test_kek_config_errors_never_leak_key(env: dict, match: str) -> None:
    with pytest.raises(KeyConfigError, match=match) as info:
        Kek.from_env(env)
    if env.get("FILEGRID_KEK"):
        assert env["FILEGRID_KEK"] not in str(info.value)


def test_keyring_from_env_with_retired_keys() -> None:
    k_new, k_old = generate_kek_b64(), generate_kek_b64()
    ring = Keyring.from_env({"FILEGRID_KEK": k_new, "FILEGRID_KEK_ID": "k2", "FILEGRID_KEK_RETIRED": f"k1:{k_old}"})
    assert ring.primary.key_id == "k2"
    assert ring.ids == ["k1", "k2"]
    assert k_new not in repr(ring) and k_old not in repr(ring)
    with pytest.raises(KeyConfigError):
        Keyring.from_env({"FILEGRID_KEK": k_new, "FILEGRID_KEK_RETIRED": "no-colon"})


def test_keys_cli(capsys, monkeypatch) -> None:  # noqa: ANN001
    assert keys_module.main(["gen"]) == 0
    printed = capsys.readouterr().out.strip()
    assert len(base64.b64decode(printed)) == 32

    monkeypatch.setenv("FILEGRID_KEK", printed)
    monkeypatch.setenv("FILEGRID_KEK_ID", "k9")
    assert keys_module.main(["check"]) == 0
    out = capsys.readouterr()
    assert "k9" in out.out and printed not in out.out + out.err

    monkeypatch.delenv("FILEGRID_KEK")
    assert keys_module.main(["check"]) == 1
    assert keys_module.main([]) == 2
