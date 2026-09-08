import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import * as authService from './auth.service';
import type { ChangePasswordInput, LoginInput, RegisterInput } from './auth.schema';

const REFRESH_COOKIE = 'refreshToken';

function contextOf(req: Request): authService.RequestContext {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

/**
 * Browsers get the refresh token as an httpOnly cookie, which puts it out of
 * reach of JavaScript and therefore out of reach of XSS. It is also returned
 * in the body for native/mobile clients that have no cookie jar.
 */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
}

function readRefreshToken(req: Request): string | undefined {
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie) return fromCookie;

  const fromBody = req.body?.refreshToken;
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined;
}

export async function register(req: Request, res: Response): Promise<void> {
  const { user, accessToken, refreshToken, expiresIn } = await authService.register(
    req.body as RegisterInput,
    contextOf(req),
  );
  setRefreshCookie(res, refreshToken);
  res.status(201).json({
    success: true,
    message: 'Account created',
    data: { user, accessToken, refreshToken, expiresIn },
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { user, accessToken, refreshToken, expiresIn } = await authService.login(
    req.body as LoginInput,
    contextOf(req),
  );
  setRefreshCookie(res, refreshToken);
  res.json({
    success: true,
    message: 'Signed in',
    data: { user, accessToken, refreshToken, expiresIn },
  });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = readRefreshToken(req);
  if (!token) throw ApiError.unauthorized('No refresh token provided');

  const tokens = await authService.refresh(token, contextOf(req));
  setRefreshCookie(res, tokens.refreshToken);
  res.json({ success: true, data: tokens });
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(readRefreshToken(req));
  clearRefreshCookie(res);
  res.json({ success: true, message: 'Signed out' });
}

export async function logoutAll(req: Request, res: Response): Promise<void> {
  await authService.logoutAll(req.user!.id);
  clearRefreshCookie(res);
  res.json({ success: true, message: 'Signed out of all devices' });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.getProfile(req.user!.id);
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: { user } });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const tokens = await authService.changePassword(
    req.user!.id,
    req.body as ChangePasswordInput,
    contextOf(req),
  );
  setRefreshCookie(res, tokens.refreshToken);
  res.json({
    success: true,
    message: 'Password changed. All other sessions have been signed out.',
    data: tokens,
  });
}
