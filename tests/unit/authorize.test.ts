import type { NextFunction, Request, Response } from 'express';
import { assertCanMutate, authorize, isSelfOrAdmin, requireAdmin } from '../../src/middlewares/authorize';
import { ApiError } from '../../src/utils/ApiError';
import { Role } from '../../src/generated/prisma/enums';
import type { AuthUser } from '../../src/types/express';

// Annotated as AuthUser so `role` widens to the enum rather than being inferred
// as the single literal each constant happens to hold.
const ADMIN: AuthUser = { id: 'admin-1', email: 'admin@example.com', role: Role.ADMIN };
const USER: AuthUser = { id: 'user-1', email: 'user@example.com', role: Role.USER };

function requestWith(user?: AuthUser): Request {
  return { user } as unknown as Request;
}

function run(middleware: ReturnType<typeof authorize>, user?: AuthUser): unknown {
  const next = jest.fn() as unknown as NextFunction;
  middleware(requestWith(user), {} as Response, next);
  return (next as unknown as jest.Mock).mock.calls[0]?.[0];
}

describe('authorize', () => {
  it('lets a matching role through', () => {
    expect(run(authorize(Role.ADMIN), ADMIN)).toBeUndefined();
  });

  it('rejects a role that is not listed with 403', () => {
    const error = run(authorize(Role.ADMIN), USER) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request with 401, not 403', () => {
    // The distinction matters: 401 tells a client to sign in, 403 tells it not to bother.
    const error = run(authorize(Role.ADMIN), undefined) as ApiError;

    expect(error.statusCode).toBe(401);
  });

  it('accepts any of several allowed roles', () => {
    const middleware = authorize(Role.USER, Role.ADMIN);

    expect(run(middleware, USER)).toBeUndefined();
    expect(run(middleware, ADMIN)).toBeUndefined();
  });

  it('rejects everyone when no role is allowed', () => {
    expect(run(authorize(), ADMIN)).toBeInstanceOf(ApiError);
  });

  it('requireAdmin is the admin-only gate', () => {
    expect(run(requireAdmin, ADMIN)).toBeUndefined();
    expect((run(requireAdmin, USER) as ApiError).statusCode).toBe(403);
  });
});

describe('isSelfOrAdmin', () => {
  it('is true for the owner', () => {
    expect(isSelfOrAdmin(requestWith(USER), USER.id)).toBe(true);
  });

  it('is true for an admin acting on someone else', () => {
    expect(isSelfOrAdmin(requestWith(ADMIN), USER.id)).toBe(true);
  });

  it('is false for a different non-admin user', () => {
    expect(isSelfOrAdmin(requestWith(USER), 'someone-else')).toBe(false);
  });

  it('is false when unauthenticated', () => {
    expect(isSelfOrAdmin(requestWith(undefined), USER.id)).toBe(false);
  });
});

describe('assertCanMutate', () => {
  it('passes for the owner and for an admin', () => {
    expect(() => assertCanMutate(requestWith(USER), USER.id)).not.toThrow();
    expect(() => assertCanMutate(requestWith(ADMIN), USER.id)).not.toThrow();
  });

  it('throws 403 for a stranger', () => {
    expect(() => assertCanMutate(requestWith(USER), 'other-id')).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});
