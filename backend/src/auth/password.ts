import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id via Node's built-in crypto.argon2 (no native package), at OWASP's minimum cost:
 * 19 MiB, 2 passes, 1 lane. Runs on libuv's thread pool, so it never blocks the event loop.
 * Stored as a standard PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>.
 */
const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const MAX_MEMORY_KIB = 1_048_576;
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(
  password: string,
  salt: Buffer,
  memory: number,
  passes: number,
  parallelism: number,
  tagLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, memory, passes, parallelism, tagLength },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const unpadded = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM, HASH_BYTES);
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${unpadded(salt)}$${unpadded(hash)}`;
}

/** Constant-time check; a malformed stored hash is just a mismatch. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = PHC_PATTERN.exec(stored);
  if (!match) return false;
  const [, memory, passes, parallelism, saltB64, hashB64] = match;
  const expected = Buffer.from(hashB64, 'base64');
  const memoryKib = Number(memory);
  if (expected.length < 16 || memoryKib > MAX_MEMORY_KIB) return false;
  try {
    const actual = await derive(
      password,
      Buffer.from(saltB64, 'base64'),
      memoryKib,
      Number(passes),
      Number(parallelism),
      expected.length,
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
