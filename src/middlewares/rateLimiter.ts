import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env';

const message = {
  success: false,
  error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
};

/** Broad ceiling applied to the whole API. */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 300 : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});

/**
 * Tight limit on credential endpoints — this is the control that makes
 * password guessing impractical. Keyed by IP + submitted email so one
 * attacker cannot lock out every user from a shared NAT address.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request): string => {
    // ipKeyGenerator normalises IPv6 into a /64 subnet key.
    const ipKey = ipKeyGenerator(req.ip ?? '');
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${ipKey}:${email}`;
  },
  message,
});

/** Slightly looser gate for account creation. */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.isProduction ? 5 : 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});

/** Applied to writes so a compromised token cannot be used to flood the DB. */
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isProduction ? 30 : 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message,
});
