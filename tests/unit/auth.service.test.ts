jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import * as authService from '../../src/modules/auth/auth.service';
import { hashPassword } from '../../src/utils/password';
import { hashToken, signRefreshToken, verifyAccessToken } from '../../src/utils/jwt';
import { Role } from '../../src/generated/prisma/enums';

const db = prismaMockFrom(prismaModule);

const USER_ID = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';
const PASSWORD = 'Str0ngPass!23';
const CTX = { ip: '127.0.0.1', userAgent: 'jest' };

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'user@example.com',
    name: 'User',
    password: passwordHash,
    role: Role.USER,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('register', () => {
  it('rejects a duplicate email with 409 and writes nothing', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(
      authService.register({ name: 'A', email: 'a@example.com', password: PASSWORD }, CTX),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('always creates a USER, whatever was asked for', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue(userRow());
    db.refreshToken.create.mockResolvedValue({});

    await authService.register(
      { name: 'A', email: 'a@example.com', password: PASSWORD, role: Role.ADMIN } as never,
      CTX,
    );

    expect(db.user.create.mock.calls[0][0].data.role).toBe(Role.USER);
  });

  it('hashes the password and excludes it from the returned user', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue(userRow());
    db.refreshToken.create.mockResolvedValue({});

    const result = await authService.register(
      { name: 'A', email: 'a@example.com', password: PASSWORD },
      CTX,
    );

    expect(db.user.create.mock.calls[0][0].data.password).not.toBe(PASSWORD);
    expect(db.user.create.mock.calls[0][0].select.password).toBeUndefined();
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it('stores only the digest of the refresh token', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue(userRow());
    db.refreshToken.create.mockResolvedValue({});

    const result = await authService.register(
      { name: 'A', email: 'a@example.com', password: PASSWORD },
      CTX,
    );

    const stored = db.refreshToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(hashToken(result.refreshToken));
    expect(stored.tokenHash).not.toBe(result.refreshToken);
    expect(stored.expiresAt).toBeInstanceOf(Date);
  });
});

describe('login', () => {
  it('signs a token carrying the subject and role', async () => {
    db.user.findUnique.mockResolvedValue(userRow({ role: Role.ADMIN }));
    db.refreshToken.create.mockResolvedValue({});

    const result = await authService.login({ email: 'user@example.com', password: PASSWORD }, CTX);
    const payload = verifyAccessToken(result.accessToken);

    expect(payload.sub).toBe(USER_ID);
    expect(payload.role).toBe(Role.ADMIN);
    expect(result.user).not.toHaveProperty('password');
  });

  it('gives the same message for an unknown email and a wrong password', async () => {
    db.user.findUnique.mockResolvedValue(null);
    const unknown = await authService
      .login({ email: 'ghost@example.com', password: PASSWORD }, CTX)
      .catch((error) => error);

    db.user.findUnique.mockResolvedValue(userRow());
    const wrong = await authService
      .login({ email: 'user@example.com', password: 'WrongPass!23' }, CTX)
      .catch((error) => error);

    // Differing messages would turn login into an account-enumeration oracle.
    expect(unknown.message).toBe(wrong.message);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it('burns time on an unknown email so the timing matches a real check', async () => {
    db.user.findUnique.mockResolvedValue(null);

    const started = process.hrtime.bigint();
    await authService.login({ email: 'ghost@example.com', password: PASSWORD }, CTX).catch(() => {});
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeGreaterThan(1);
  });

  it('refuses a deactivated account with 403', async () => {
    db.user.findUnique.mockResolvedValue(userRow({ isActive: false }));

    await expect(
      authService.login({ email: 'user@example.com', password: PASSWORD }, CTX),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('checks the password before the active flag, so a wrong password never reveals status', async () => {
    db.user.findUnique.mockResolvedValue(userRow({ isActive: false }));

    const error = await authService
      .login({ email: 'user@example.com', password: 'WrongPass!23' }, CTX)
      .catch((e) => e);

    expect(error.statusCode).toBe(401);
  });
});

describe('refresh rotation', () => {
  function storedToken(overrides: Record<string, unknown> = {}) {
    return {
      id: 'token-row-1',
      userId: USER_ID,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      user: {
        id: USER_ID,
        role: Role.USER,
        isActive: true,
        tokensValidFrom: new Date(Date.now() - 60_000),
      },
      ...overrides,
    };
  }

  it('rejects a token that is not in the database', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(null);

    await expect(authService.refresh(token, CTX)).rejects.toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('looks the token up by digest, never by its raw value', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(storedToken());

    await authService.refresh(token, CTX);

    expect(db.refreshToken.findUnique.mock.calls[0][0].where).toEqual({
      tokenHash: hashToken(token),
    });
  });

  it('revokes the old token and issues a new one in a single transaction', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(storedToken());

    const result = await authService.refresh(token, CTX);

    expect(result.refreshToken).not.toBe(token);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'token-row-1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    expect(db.refreshToken.create).toHaveBeenCalled();
  });

  it('treats reuse of a revoked token as a breach and kills every session', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(storedToken({ revokedAt: new Date() }));

    await expect(authService.refresh(token, CTX)).rejects.toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('rejects an expired row even when the JWT itself is still valid', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(
      storedToken({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(authService.refresh(token, CTX)).rejects.toThrow(
      expect.objectContaining({ code: 'REFRESH_TOKEN_EXPIRED' }),
    );
  });

  it('rejects a token belonging to a deactivated user', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(
      storedToken({
        user: { id: USER_ID, role: Role.USER, isActive: false, tokensValidFrom: new Date(0) },
      }),
    );

    await expect(authService.refresh(token, CTX)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it('rejects a token created before tokensValidFrom', async () => {
    const { token } = signRefreshToken(USER_ID);
    db.refreshToken.findUnique.mockResolvedValue(
      storedToken({
        createdAt: new Date(Date.now() - 120_000),
        user: {
          id: USER_ID,
          role: Role.USER,
          isActive: true,
          tokensValidFrom: new Date(Date.now() - 1000),
        },
      }),
    );

    await expect(authService.refresh(token, CTX)).rejects.toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('rejects a token whose subject does not match the stored row', async () => {
    const { token } = signRefreshToken('a-different-user');
    db.refreshToken.findUnique.mockResolvedValue(storedToken());

    await expect(authService.refresh(token, CTX)).rejects.toThrow(
      expect.objectContaining({ statusCode: 401 }),
    );
  });
});

describe('logout', () => {
  it('revokes only the presented token', async () => {
    const { token } = signRefreshToken(USER_ID);

    await authService.logout(token);

    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('is a no-op when no token is supplied', async () => {
    await authService.logout(undefined);

    expect(db.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});

describe('logoutAll', () => {
  it('revokes every refresh token and advances the access-token cut-off', async () => {
    await authService.logoutAll(USER_ID);

    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { tokensValidFrom: expect.any(Date) },
    });
  });
});

describe('changePassword', () => {
  it('rejects a wrong current password and changes nothing', async () => {
    db.user.findUnique.mockResolvedValue({ id: USER_ID, password: passwordHash, role: Role.USER });

    await expect(
      authService.changePassword(
        USER_ID,
        { currentPassword: 'WrongPass!23', newPassword: 'An0therPass!' },
        CTX,
      ),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('stores a new hash and revokes other sessions', async () => {
    db.user.findUnique.mockResolvedValue({ id: USER_ID, password: passwordHash, role: Role.USER });
    db.refreshToken.create.mockResolvedValue({});

    const tokens = await authService.changePassword(
      USER_ID,
      { currentPassword: PASSWORD, newPassword: 'An0therPass!' },
      CTX,
    );

    const written = db.user.update.mock.calls[0][0].data;
    expect(written.password).not.toBe('An0therPass!');
    expect(written.tokensValidFrom).toBeInstanceOf(Date);
    expect(db.refreshToken.updateMany).toHaveBeenCalled();
    // The device that made the change is handed a fresh pair, not logged out.
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();
  });

  it('404s for a missing user', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(
      authService.changePassword(
        USER_ID,
        { currentPassword: PASSWORD, newPassword: 'An0therPass!' },
        CTX,
      ),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});
