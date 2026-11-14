import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KEY_BYTES, Kek, Keyring } from './keys';

/**
 * Streamed envelope encryption (AES-256-GCM), byte-compatible with P1's `envelope.py` (format FGE1):
 *   header  = "FGE1" | 0x01 | key_id_len | key_id | wrap_nonce(12) | wrapped_dek(32+16) | nonce_prefix(7)
 *   body    = segment_0 .. segment_last, each AES-256-GCM(DEK, prefix | u32 BE counter | last flag,
 *             64 KiB of plaintext (last: 0..64 KiB), aad = header) -> ciphertext | tag(16)
 * A fresh DEK per object, wrapped under the KEK with aad = magic | version | key_id_len | key_id.
 * Each segment is authenticated before it is released; the counter and the last flag make
 * reordering, dropping, truncating or appending segments detectable (STREAM construction).
 */

export const MAGIC = Buffer.from('FGE1');
export const VERSION = 1;
export const SEGMENT_SIZE = 64 * 1024;
export const TAG_SIZE = 16;
const NONCE_PREFIX_SIZE = 7;
const WRAP_NONCE_SIZE = 12;
const WRAPPED_DEK_SIZE = KEY_BYTES + TAG_SIZE;
const MAX_SEGMENTS = 2 ** 32;

export class CryptoError extends Error {
  override readonly name: string = 'CryptoError';
}

export class DecryptionError extends CryptoError {
  override readonly name = 'DecryptionError';
}

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  if (counter >= MAX_SEGMENTS) throw new CryptoError('object too large for one encryption stream');
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(counter, 0);
  tail[4] = last ? 1 : 0;
  return Buffer.concat([prefix, tail]);
}

function wrapAad(keyId: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([VERSION, keyId.length]), keyId]);
}

function seal(key: Buffer, iv: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, iv: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_SIZE)),
    decipher.final(),
  ]);
}

export function isEncryptedPrefix(data: Buffer): boolean {
  return data.length >= 5 && data.subarray(0, 4).equals(MAGIC) && data[4] === VERSION;
}

/** Encrypts a byte stream under a fresh DEK wrapped by `kek`; yields the header, then segments. */
export async function* encryptStream(
  chunks: AsyncIterable<Uint8Array>,
  kek: Kek,
): AsyncGenerator<Buffer, void, undefined> {
  const dek = randomBytes(KEY_BYTES);
  const keyId = Buffer.from(kek.keyId, 'ascii');
  const wrapNonce = randomBytes(WRAP_NONCE_SIZE);
  const wrapped = seal(kek.key, wrapNonce, dek, wrapAad(keyId));
  const prefix = randomBytes(NONCE_PREFIX_SIZE);
  const header = Buffer.concat([wrapAad(keyId), wrapNonce, wrapped, prefix]);
  let counter = 0;
  let buffered: Buffer[] = [];
  let length = 0;
  yield header;
  for await (const chunk of chunks) {
    if (chunk.length === 0) continue;
    buffered.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    length += chunk.length;
    // Seal only segments known not to be the last one (more bytes follow them).
    if (length <= SEGMENT_SIZE) continue;
    const all = Buffer.concat(buffered);
    const ready = Math.floor((all.length - 1) / SEGMENT_SIZE) * SEGMENT_SIZE;
    for (let offset = 0; offset < ready; offset += SEGMENT_SIZE) {
      yield seal(
        dek,
        nonce(prefix, counter, false),
        all.subarray(offset, offset + SEGMENT_SIZE),
        header,
      );
      counter += 1;
    }
    const rest = Buffer.from(all.subarray(ready));
    buffered = [rest];
    length = rest.length;
  }
  yield seal(dek, nonce(prefix, counter, true), Buffer.concat(buffered), header);
}

/** Pulls exact byte counts out of a chunk stream with a bounded buffer. */
class Reader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer: Buffer = Buffer.alloc(0);
  private eof = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    const parts: Buffer[] = [this.buffer];
    let length = this.buffer.length;
    while (length < n && !this.eof) {
      const next = await this.iterator.next();
      if (next.done) {
        this.eof = true;
        break;
      }
      parts.push(Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
      length += next.value.length;
    }
    if (parts.length > 1) this.buffer = Buffer.concat(parts);
  }

  async readExact(n: number): Promise<Buffer> {
    await this.fill(n);
    if (this.buffer.length < n) throw new DecryptionError('truncated header');
    return this.take(n);
  }

  /** Up to `n` bytes, and whether more data follows them. */
  async readUpTo(n: number): Promise<[Buffer, boolean]> {
    await this.fill(n + 1);
    const out = this.take(Math.min(n, this.buffer.length));
    return [out, this.buffer.length > 0];
  }

  private take(n: number): Buffer {
    const out = Buffer.from(this.buffer.subarray(0, n));
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async close(): Promise<void> {
    try {
      await this.iterator.return?.();
    } catch {
      // closing must never mask the original outcome
    }
  }
}

/** Decrypts an FGE1 stream; yields plaintext one verified 64 KiB segment at a time. */
export async function* decryptStream(
  chunks: AsyncIterable<Uint8Array>,
  keyring: Keyring | Kek,
): AsyncGenerator<Buffer, void, undefined> {
  const ring = keyring instanceof Kek ? new Keyring(keyring) : keyring;
  const reader = new Reader(chunks);
  try {
    const fixed = await reader.readExact(6);
    if (!fixed.subarray(0, 4).equals(MAGIC)) throw new DecryptionError('not an FGE1 object');
    if (fixed[4] !== VERSION) throw new DecryptionError(`unsupported FGE version ${fixed[4]}`);
    const keyIdLength = fixed[5] ?? 0;
    if (keyIdLength < 1 || keyIdLength > 64) throw new DecryptionError('invalid key id length');
    const rest = await reader.readExact(
      keyIdLength + WRAP_NONCE_SIZE + WRAPPED_DEK_SIZE + NONCE_PREFIX_SIZE,
    );
    const keyId = rest.subarray(0, keyIdLength);
    const wrapNonce = rest.subarray(keyIdLength, keyIdLength + WRAP_NONCE_SIZE);
    const wrapped = rest.subarray(
      keyIdLength + WRAP_NONCE_SIZE,
      keyIdLength + WRAP_NONCE_SIZE + WRAPPED_DEK_SIZE,
    );
    const prefix = rest.subarray(rest.length - NONCE_PREFIX_SIZE);
    const header = Buffer.concat([fixed, rest]);
    const kek = ring.get(keyId.toString('ascii'));
    if (!kek)
      throw new DecryptionError('object was encrypted with a key id that is not configured');
    let dek: Buffer;
    try {
      dek = open(kek.key, wrapNonce, wrapped, wrapAad(keyId));
    } catch {
      throw new DecryptionError('cannot unwrap the data key: wrong KEK or tampered header');
    }
    for (let counter = 0; ; counter += 1) {
      const [sealed, more] = await reader.readUpTo(SEGMENT_SIZE + TAG_SIZE);
      if (sealed.length < TAG_SIZE) throw new DecryptionError('truncated ciphertext');
      let plain: Buffer;
      try {
        plain = open(dek, nonce(prefix, counter, !more), sealed, header);
      } catch {
        throw new DecryptionError(
          `segment ${counter} failed authentication (tampered, reordered, truncated or extended)`,
        );
      }
      if (plain.length > 0) yield plain;
      if (!more) return;
    }
  } finally {
    await reader.close();
  }
}
