import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../utils/jwt';

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Verifies the access token and loads the current user state.
 *
 * The database round-trip is deliberate: it is what makes deactivation,
 * deletion and "log out everywhere" take effect immediately instead of
 * lingering until the access token expires.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) throw ApiError.unauthorized('Missing bearer token');

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        tokensValidFrom: true,
      },
    });

    if (!user) throw ApiError.unauthorized('Account no longer exists');
    if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

    // Tokens minted before the cut-off (password change, forced logout) are dead.
    const issuedAt = payload.iat ? new Date(payload.iat * 1000) : null;
    if (!issuedAt || issuedAt < new Date(Math.floor(user.tokensValidFrom.getTime() / 1000) * 1000)) {
      throw ApiError.unauthorized('Session is no longer valid, please sign in again');
    }

    // The role comes from the database, not from the token, so a privilege
    // change cannot be outrun by an access token minted before the change.
    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
}

/** Attaches req.user when a valid token is present, but never rejects. */
export async function optionalAuthenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.headers.authorization) return next();
  try {
    await authenticate(req, res, next);
  } catch {
    next();
  }
}
