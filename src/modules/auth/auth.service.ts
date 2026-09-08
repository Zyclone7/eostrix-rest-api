import { prisma } from '../../config/prisma';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ApiError } from '../../utils/ApiError';
import { fakePasswordCheck, hashPassword, verifyPassword } from '../../utils/password';
import {
  expiryDateOf,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../utils/jwt';
import { Role } from '../../generated/prisma/enums';
import type { ChangePasswordInput, LoginInput, RegisterInput } from './auth.schema';

/** Columns that are safe to serialise. `password` is never among them. */
export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

async function issueTokens(
  userId: string,
  role: Role,
  ctx: RequestContext,
): Promise<TokenPair> {
  const accessToken = signAccessToken(userId, role);
  const { token: refreshToken } = signRefreshToken(userId);

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshToken),
      userId,
      expiresAt: expiryDateOf(refreshToken),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 255) ?? null,
    },
  });

  return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_EXPIRES_IN };
}

export async function register(input: RegisterInput, ctx: RequestContext) {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      password: await hashPassword(input.password),
      role: Role.USER, // never taken from client input
    },
    select: publicUserSelect,
  });

  const tokens = await issueTokens(user.id, user.role, ctx);
  return { user, ...tokens };
}

export async function login(input: LoginInput, ctx: RequestContext) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Same error and comparable timing for "no such user" and "wrong password",
  // so the endpoint cannot be used to enumerate registered addresses.
  if (!user) {
    await fakePasswordCheck();
    throw ApiError.unauthorized('Invalid email or password');
  }

  const passwordMatches = await verifyPassword(input.password, user.password);
  if (!passwordMatches) throw ApiError.unauthorized('Invalid email or password');

  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  const tokens = await issueTokens(user.id, user.role, ctx);

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    ...tokens,
  };
}

/**
 * Rotating refresh. The presented token is revoked and replaced on every call.
 *
 * If a token that was *already* rotated is presented again, that means the
 * token leaked (the legitimate client and an attacker both hold copies), so
 * every session for that user is destroyed rather than just this one.
 */
export async function refresh(token: string, ctx: RequestContext): Promise<TokenPair> {
  const payload = verifyRefreshToken(token);
  const tokenHash = hashToken(token);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, role: true, isActive: true, tokensValidFrom: true } } },
  });

  if (!stored) throw ApiError.unauthorized('Invalid refresh token');

  if (stored.revokedAt) {
    logger.warn({ userId: stored.userId }, 'Refresh token reuse detected — revoking all sessions');
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw ApiError.unauthorized('Refresh token has been revoked, please sign in again');
  }

  if (stored.expiresAt < new Date()) {
    throw new ApiError(401, 'Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  if (!stored.user.isActive) throw ApiError.forbidden('This account has been deactivated');
  if (stored.createdAt < stored.user.tokensValidFrom) {
    throw ApiError.unauthorized('Session is no longer valid, please sign in again');
  }
  if (payload.sub !== stored.userId) throw ApiError.unauthorized('Invalid refresh token');

  const accessToken = signAccessToken(stored.userId, stored.user.role);
  const { token: newRefreshToken } = signRefreshToken(stored.userId);
  const newHash = hashToken(newRefreshToken);

  // One transaction: the old token dies exactly when the new one is born.
  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: newHash },
    }),
    prisma.refreshToken.create({
      data: {
        tokenHash: newHash,
        userId: stored.userId,
        expiresAt: expiryDateOf(newRefreshToken),
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent?.slice(0, 255) ?? null,
      },
    }),
  ]);

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  };
}

/** Revokes a single session. Silent when the token is already gone. */
export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes every session for a user, including outstanding access tokens. */
export async function logoutAll(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.user.update({ where: { id: userId }, data: { tokensValidFrom: new Date() } }),
  ]);
}

export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  ctx: RequestContext,
): Promise<TokenPair> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, password: true, role: true },
  });
  if (!user) throw ApiError.notFound('User not found');

  const matches = await verifyPassword(input.currentPassword, user.password);
  if (!matches) throw ApiError.unauthorized('Current password is incorrect');

  const newHash = await hashPassword(input.newPassword);

  // Changing a password ends every other session; the caller is then handed a
  // fresh pair so they are not logged out of the device that made the change.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { password: newHash, tokensValidFrom: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  return issueTokens(user.id, user.role, ctx);
}

export function getProfile(userId: string) {
  return prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
}
