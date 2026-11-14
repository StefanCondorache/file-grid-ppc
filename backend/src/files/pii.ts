import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Keyring } from '../crypto/keys';

/**
 * Personal data of connection documents (applicant name, CNP) is never stored in clear: it is sealed
 * with AES-256-GCM under the KEK (the same key that wraps the documents' data keys) and only masked
 * values go into the searchable metadata. Format: `pii1.<keyId>.<nonce b64url>.<ciphertext+tag b64url>`.
 */

export interface ConnectionPii {
  readonly applicantName: string;
  readonly cnp: string;
}

const AAD = Buffer.from('filegrid-pii-v1');

export function sealPii(pii: ConnectionPii, keyring: Keyring): string {
  const kek = keyring.primary;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek.key, nonce);
  cipher.setAAD(AAD);
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(pii), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return ['pii1', kek.keyId, nonce.toString('base64url'), sealed.toString('base64url')].join('.');
}

export function openPii(sealed: string, keyring: Keyring): ConnectionPii {
  const [version, keyId, nonce, body] = sealed.split('.');
  const kek = keyId ? keyring.get(keyId) : undefined;
  if (version !== 'pii1' || !kek || !nonce || !body) throw new Error('unreadable personal data');
  const bytes = Buffer.from(body, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', kek.key, Buffer.from(nonce, 'base64url'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.length - 16)),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8')) as ConnectionPii;
}

/** "Ion Popescu" -> "I*** P***". */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${[...part][0] ?? ''}***`)
    .join(' ');
}

/** "1960101123456" -> "1*********456". */
export function maskCnp(cnp: string): string {
  return cnp.length < 4
    ? '*'.repeat(cnp.length)
    : `${cnp[0]}${'*'.repeat(cnp.length - 4)}${cnp.slice(-3)}`;
}
