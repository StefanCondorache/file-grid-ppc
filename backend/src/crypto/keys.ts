import { randomBytes } from 'node:crypto';

/**
 * Key-encryption keys (KEK) for the envelope encryption of connection documents. Port of P1's
 * `backend/app/crypto/keys.py`; the KEK never lives in the repository:
 *   FILEGRID_KEK          base64 of 32 random bytes (Secret filegrid-app-secrets)
 *   FILEGRID_KEK_ID       short id stored in every encrypted object's header, default k1
 *   FILEGRID_KEK_RETIRED  optional `id:base64,id:base64`; retired keys only decrypt (rotation)
 * Key material never appears in messages, logs or JSON.
 */

export const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class KeyConfigError extends Error {
  override readonly name = 'KeyConfigError';
}

function decodeKey(value: string, what: string): Buffer {
  const normalised = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised))
    throw new KeyConfigError(`${what} is not valid base64`);
  const raw = Buffer.from(normalised, 'base64');
  if (raw.length !== KEY_BYTES) {
    throw new KeyConfigError(`${what} must decode to ${KEY_BYTES} bytes, got ${raw.length}`);
  }
  return raw;
}

function checkId(keyId: string): string {
  if (!KEY_ID.test(keyId)) throw new KeyConfigError('key id must match [A-Za-z0-9._-]{1,64}');
  return keyId;
}

/** A named 256-bit key-encryption key. */
export class Kek {
  readonly keyId: string;
  readonly key: Buffer;

  constructor(keyId: string, key: Buffer) {
    this.keyId = checkId(keyId);
    if (key.length !== KEY_BYTES) throw new KeyConfigError(`KEK must be ${KEY_BYTES} bytes`);
    this.key = key;
  }

  static generate(keyId = 'k1'): Kek {
    return new Kek(keyId, randomBytes(KEY_BYTES));
  }

  static fromBase64(keyId: string, value: string): Kek {
    return new Kek(checkId(keyId), decodeKey(value, `key ${keyId}`));
  }

  toJSON(): { keyId: string } {
    return { keyId: this.keyId };
  }
}

/** Keys available for decryption, by id; `primary` is the one used to encrypt. */
export class Keyring {
  private readonly keys = new Map<string, Kek>();

  constructor(
    readonly primary: Kek,
    retired: Iterable<Kek> = [],
  ) {
    for (const kek of [...retired, primary]) this.keys.set(kek.keyId, kek);
  }

  get ids(): string[] {
    return [...this.keys.keys()].sort();
  }

  get(keyId: string): Kek | undefined {
    return this.keys.get(keyId);
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>>): Keyring {
    const value = env.FILEGRID_KEK ?? '';
    if (!value) throw new KeyConfigError('FILEGRID_KEK is not set');
    const primary = new Kek(checkId(env.FILEGRID_KEK_ID || 'k1'), decodeKey(value, 'FILEGRID_KEK'));
    const retired = (env.FILEGRID_KEK_RETIRED ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf(':');
        if (separator < 0)
          throw new KeyConfigError('FILEGRID_KEK_RETIRED entries must look like id:base64');
        return Kek.fromBase64(item.slice(0, separator).trim(), item.slice(separator + 1));
      });
    return new Keyring(primary, retired);
  }

  toJSON(): { primary: string; ids: string[] } {
    return { primary: this.primary.keyId, ids: this.ids };
  }
}
