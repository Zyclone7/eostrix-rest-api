import crypto from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { ApiError } from './ApiError';
import type { Role } from '../generated/prisma/enums';

const ISSUER = 'express-ts-crud-api';
const AUDIENCE = 'express-ts-crud-api:client';

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  role: Role;
  type: 'access';
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ role, type: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

export function signRefreshToken(userId: string): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ type: 'refresh' }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    jwtid: jti,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
  });
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as AccessTokenPayload;

    // A refresh token must never be accepted where an access token is expected.
    if (payload.type !== 'access') throw new Error('wrong token type');
    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Access token has expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as RefreshTokenPayload;

    if (payload.type !== 'refresh') throw new Error('wrong token type');
    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid refresh token');
  }
}

/** Refresh tokens are persisted as digests so a DB dump cannot be replayed. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Seconds until a signed token expires, derived from its own `exp` claim. */
export function expiryDateOf(token: string): Date {
  const decoded = jwt.decode(token) as JwtPayload | null;
  if (!decoded?.exp) throw ApiError.internal('Signed token is missing an exp claim');
  return new Date(decoded.exp * 1000);
}
