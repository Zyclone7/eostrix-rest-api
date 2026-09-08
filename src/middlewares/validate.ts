import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { ApiError } from '../utils/ApiError';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * HTTP Parameter Pollution guard.
 *
 * `?limit=5&limit=100` reaches Express as an array. The usual remedy (`hpp`)
 * rewrites `req.query` in place, which is a silent no-op on Express 5 because
 * `req.query` is a getter with no setter — so the collapse happens here, on the
 * copy handed to Zod, which is the same object every handler downstream reads.
 * Last value wins, matching the conventional behaviour.
 *
 * No endpoint in this API takes a repeated parameter; if one ever does, it must
 * opt out of this helper.
 */
function collapseDuplicates(source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return source;

  const collapsed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    collapsed[key] = Array.isArray(value) ? value.at(-1) : value;
  }
  return collapsed;
}

function formatIssues(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Validates and *replaces* the request input with the parsed result, so every
 * handler downstream works with typed, coerced, whitelisted data. Unknown keys
 * are stripped by Zod's default object behaviour, which is what stops mass
 * assignment (e.g. a client trying to smuggle `"role": "ADMIN"` into signup).
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.validatedQuery = schemas.query.parse(collapseDuplicates(req.query));
      if (schemas.params) req.validatedParams = schemas.params.parse(req.params);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(ApiError.badRequest('Validation failed', formatIssues(error)));
      }
      next(error);
    }
  };
}

/** Typed accessor for the parsed query string. */
export function query<T>(req: Request): T {
  return req.validatedQuery as T;
}

/** Typed accessor for the parsed route parameters. */
export function params<T>(req: Request): T {
  return req.validatedParams as T;
}
