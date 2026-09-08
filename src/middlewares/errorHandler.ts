import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { JsonWebTokenError } from 'jsonwebtoken';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { Prisma } from '../generated/prisma/client';

/** 404 fallback for unmatched routes. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

/**
 * body-parser rejects malformed or oversized payloads with a plain Error that
 * carries `type` and `status`. Those are client faults, so they must surface
 * as 4xx rather than being swept into the generic 500 bucket.
 */
function asBodyParserError(error: unknown): ApiError | null {
  if (typeof error !== 'object' || error === null || !('type' in error)) return null;
  const { type, status } = error as { type?: string; status?: number };

  switch (type) {
    case 'entity.too.large':
      return new ApiError(413, 'Request payload is too large', 'PAYLOAD_TOO_LARGE');
    case 'entity.parse.failed':
      return ApiError.badRequest('Request body is not valid JSON');
    case 'encoding.unsupported':
      return ApiError.badRequest('Unsupported content encoding');
    case 'entity.verification.failed':
    case 'request.aborted':
      return new ApiError(status ?? 400, 'Request could not be read', 'BAD_REQUEST');
    default:
      return null;
  }
}

function normalise(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const bodyParserError = asBodyParserError(error);
  if (bodyParserError) return bodyParserError;

  if (error instanceof ZodError) {
    return ApiError.badRequest(
      'Validation failed',
      error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }

  if (error instanceof JsonWebTokenError) {
    return ApiError.unauthorized('Invalid token');
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
        return ApiError.conflict(`A record with this ${target} already exists`);
      }
      case 'P2025':
        return ApiError.notFound('Record not found');
      case 'P2003':
        return ApiError.badRequest('Related record does not exist');
      default:
        // Unmapped Prisma codes are internal faults, not client errors.
        return ApiError.internal();
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return ApiError.badRequest('Malformed query');
  }

  return ApiError.internal();
}

/**
 * Terminal error handler. Only `ApiError`s carry a client-facing message;
 * everything else collapses to a generic 500 so internal details — SQL,
 * file paths, stack traces — never reach the response body.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(error);

  const apiError = normalise(error);

  if (apiError.statusCode >= 500) {
    logger.error(
      { err: error, method: req.method, url: req.originalUrl, userId: req.user?.id },
      'Unhandled error',
    );
  } else {
    logger.warn(
      { code: apiError.code, method: req.method, url: req.originalUrl, userId: req.user?.id },
      apiError.message,
    );
  }

  res.status(apiError.statusCode).json({
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
      // Stacks are a development affordance only.
      ...(env.isProduction || apiError.statusCode < 500
        ? {}
        : { stack: error instanceof Error ? error.stack : undefined }),
    },
  });
}
