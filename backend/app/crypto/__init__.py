"""FileGrid encryption (P1): streamed AES-256-GCM envelope encryption for connection documents.

See ``envelope.py`` for the format and usage, ``keys.py`` for key configuration and rotation.
"""

from .envelope import (
    SEGMENT_SIZE,
    CryptoError,
    DecryptionError,
    decrypt_stream,
    encrypt_stream,
    is_encrypted_prefix,
)
from .keys import Kek, KeyConfigError, Keyring, generate_kek_b64

__all__ = [
    "SEGMENT_SIZE",
    "CryptoError",
    "DecryptionError",
    "Kek",
    "KeyConfigError",
    "Keyring",
    "decrypt_stream",
    "encrypt_stream",
    "generate_kek_b64",
    "is_encrypted_prefix",
]
