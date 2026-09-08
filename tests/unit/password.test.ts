import { fakePasswordCheck, hashPassword, verifyPassword } from '../../src/utils/password';

describe('hashPassword', () => {
  it('produces a bcrypt hash, never the plaintext', async () => {
    const hash = await hashPassword('Str0ngPass!23');

    expect(hash).not.toBe('Str0ngPass!23');
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('Str0ngPass!23'), hashPassword('Str0ngPass!23')]);

    expect(a).not.toBe(b);
  });

  it('uses the configured cost factor', async () => {
    const hash = await hashPassword('Str0ngPass!23');

    expect(hash.split('$')[2]).toBe(process.env.BCRYPT_ROUNDS?.padStart(2, '0'));
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword('Str0ngPass!23');

    await expect(verifyPassword('Str0ngPass!23', hash)).resolves.toBe(true);
  });

  it.each([
    ['a different password', 'WrongPass!23'],
    ['a case variation', 'str0ngpass!23'],
    ['an empty string', ''],
    ['a prefix of the real password', 'Str0ngPass'],
  ])('rejects %s', async (_label, attempt) => {
    const hash = await hashPassword('Str0ngPass!23');

    await expect(verifyPassword(attempt, hash)).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword('Str0ngPass!23', 'not-a-hash')).resolves.toBe(false);
  });
});

describe('fakePasswordCheck', () => {
  it('resolves without throwing', async () => {
    await expect(fakePasswordCheck()).resolves.toBeUndefined();
  });

  it('actually burns time, so it is a usable timing decoy', async () => {
    // A comparison against a malformed hash returns instantly and would defeat
    // the purpose; a genuine bcrypt comparison cannot.
    const started = process.hrtime.bigint();
    await fakePasswordCheck();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeGreaterThan(1);
  });
});
