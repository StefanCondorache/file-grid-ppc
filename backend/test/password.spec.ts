import { hashPassword, verifyPassword } from '../src/auth/password';

describe('password hashing', () => {
  it('stores argon2id PHC strings at the OWASP minimum cost', async () => {
    const hash = await hashPassword('correct horse battery');

    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');

    await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'correct horse batterY')).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toBe(second);
  });

  it.each(['not-a-hash', '$argon2id$v=19$m=19456,t=2,p=1$bad', ''])(
    'treats a malformed stored hash (%p) as a mismatch',
    async (stored) => {
      await expect(verifyPassword(stored, 'anything')).resolves.toBe(false);
    },
  );
});
