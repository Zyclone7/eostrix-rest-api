import type { Role } from '../generated/prisma/enums';

/**
 * The authenticated principal attached by the `authenticate` middleware.
 * It is intentionally minimal — never the full user row, never the hash.
 */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      id?: string;
      /**
       * Output of the `validate` middleware. Express 5 exposes `req.query` and
       * `req.params` as getters that cannot be reassigned, so the parsed and
       * coerced values are surfaced here instead.
       */
      validatedQuery?: unknown;
      validatedParams?: unknown;
    }
  }
}

export {};
