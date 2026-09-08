import type { NextFunction, Request, Response } from 'express';

jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import { authenticate, optionalAuthenticate } from '../../src/middlewares/authenticate';
import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import { signAccessToken, signRefreshToken } from '../../src/utils/jwt';
import { ApiError } from '../../src/utils/ApiError';
import { Role } from '../../src/generated/prisma/enums';

const db = prismaMockFrom(prismaModule);
const USER_ID = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';

/** A user row as `authenticate` selects it. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'user@example.com',
    role: Role.USER,
    isActive: true,
    // Well in the past, so a freshly minted token is always newer.
    tokensValidFrom: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

async function run(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  const next = jest.fn();

  await authenticate(req, {} as Response, next as unknown as NextFunction);

  return { req, error: next.mock.calls[0]?.[0] as ApiError | undefined };
}

describe('token extraction', () => {
  it('accepts a well-formed bearer header', async () => {
    db.user.findUnique.mockResolvedValue(userRow());

    const { req, error } = await run(`Bearer ${signAccessToken(USER_ID, Role.USER)}`);

    expect(error).toBeUndefined();
    expect(req.user).toEqual({ id: USER_ID, email: 'user@example.com', role: Role.USER });
  });

  it('is case-insensitive about the scheme', async () => {
    db.user.findUnique.mockResolvedValue(userRow());

    const { error } = await run(`bearer ${signAccessToken(USER_ID, Role.USER)}`);

    expect(error).toBeUndefined();
  });

  it.each([
    ['no header at all', undefined],
    ['an empty header', ''],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare token', 'just-a-token'],
    ['bearer with no token', 'Bearer '],
  ])('rejects %s with 401', async (_label, header) => {
    const { error } = await run(header);

    expect(error?.statusCode).toBe(401);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a refresh token presented as an access token', async () => {
    const { token } = signRefreshToken(USER_ID);

    const { error } = await run(`Bearer ${token}`);

    expect(error?.statusCode).toBe(401);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('account state', () => {
  it('rejects a token for a user that no longer exists', async () => {
    db.user.findUnique.mockResolvedValue(null);

    const { error } = await run(`Bearer ${signAccessToken(USER_ID, Role.USER)}`);

    expect(error?.statusCode).toBe(401);
    expect(error?.message).toContain('no longer exists');
  });

  it('rejects a deactivated account with 403', async () => {
    db.user.findUnique.mockResolvedValue(userRow({ isActive: false }));

    const { error } = await run(`Bearer ${signAccessToken(USER_ID, Role.USER)}`);

    expect(error?.statusCode).toBe(403);
  });

  it('rejects a token minted before tokensValidFrom', async () => {
    // Simulates a password change or a forced logout after the token was issued.
    const token = signAccessToken(USER_ID, Role.USER);
    db.user.findUnique.mockResolvedValue(
      userRow({ tokensValidFrom: new Date(Date.now() + 60_000) }),
    );

    const { error } = await run(`Bearer ${token}`);

    expect(error?.statusCode).toBe(401);
    expect(error?.message).toContain('no longer valid');
  });

  it('does not reject a token issued in the same second as tokensValidFrom', async () => {
    // `iat` has one-second resolution; without flooring, a token minted
    // immediately after a password change would be rejected as stale.
    const token = signAccessToken(USER_ID, Role.USER);
    db.user.findUnique.mockResolvedValue(userRow({ tokensValidFrom: new Date() }));

    const { error } = await run(`Bearer ${token}`);

    expect(error).toBeUndefined();
  });
});

describe('role source', () => {
  it('takes the role from the database, not from the token', async () => {
    // The token claims ADMIN; the row says USER. The row must win, otherwise a
    // demotion could be outrun by a token minted before it.
    const staleAdminToken = signAccessToken(USER_ID, Role.ADMIN);
    db.user.findUnique.mockResolvedValue(userRow({ role: Role.USER }));

    const { req, error } = await run(`Bearer ${staleAdminToken}`);

    expect(error).toBeUndefined();
    expect(req.user?.role).toBe(Role.USER);
  });

  it('never attaches the password hash to the request', async () => {
    db.user.findUnique.mockResolvedValue(userRow());

    const { req } = await run(`Bearer ${signAccessToken(USER_ID, Role.USER)}`);

    expect(req.user).not.toHaveProperty('password');
    // The select must not ask for it in the first place.
    const select = db.user.findUnique.mock.calls[0][0].select;
    expect(select.password).toBeUndefined();
  });
});

describe('optionalAuthenticate', () => {
  it('passes straight through with no header', async () => {
    const req = { headers: {} } as unknown as Request;
    const next = jest.fn();

    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeUndefined();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('attaches the user when a valid token is present', async () => {
    db.user.findUnique.mockResolvedValue(userRow());
    const req = {
      headers: { authorization: `Bearer ${signAccessToken(USER_ID, Role.USER)}` },
    } as unknown as Request;
    const next = jest.fn();

    await optionalAuthenticate(req, {} as Response, next as unknown as NextFunction);

    expect(req.user?.id).toBe(USER_ID);
  });
});
