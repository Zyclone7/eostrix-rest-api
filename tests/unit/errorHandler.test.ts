import type { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';
import { JsonWebTokenError } from 'jsonwebtoken';
import { errorHandler, notFoundHandler } from '../../src/middlewares/errorHandler';
import { ApiError } from '../../src/utils/ApiError';
import { Prisma } from '../../src/generated/prisma/client';

interface Captured {
  status: number;
  body: any;
}

function handle(error: unknown, headersSent = false): { captured: Captured; forwarded: unknown } {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    headersSent,
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;

  const next = jest.fn();
  const req = { method: 'GET', originalUrl: '/api/v1/thing' } as Request;
  errorHandler(error, req, res, next as unknown as NextFunction);

  return { captured, forwarded: next.mock.calls[0]?.[0] };
}

describe('notFoundHandler', () => {
  it('forwards a 404 naming the route', () => {
    const next = jest.fn();
    notFoundHandler(
      { method: 'GET', originalUrl: '/api/v1/nope' } as Request,
      {} as Response,
      next as unknown as NextFunction,
    );

    const error = next.mock.calls[0][0] as ApiError;
    expect(error.statusCode).toBe(404);
    expect(error.message).toContain('/api/v1/nope');
  });
});

describe('ApiError passthrough', () => {
  it('uses the status, code and message it carries', () => {
    const { captured } = handle(ApiError.forbidden('Nope'));

    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Nope' },
    });
  });

  it('includes details when present', () => {
    const { captured } = handle(ApiError.badRequest('Validation failed', [{ field: 'email' }]));

    expect(captured.body.error.details).toEqual([{ field: 'email' }]);
  });
});

describe('unknown errors', () => {
  it('collapses to a generic 500 without leaking the message', () => {
    const { captured } = handle(new Error('connect ECONNREFUSED 10.0.0.5:5432 as user postgres'));

    expect(captured.status).toBe(500);
    expect(captured.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    // The client-facing message is generic; the real one is only logged.
    expect(captured.body.error.message).toBe('Internal server error');
    expect(captured.body.error.details).toBeUndefined();
  });

  it('handles a thrown non-Error value', () => {
    const { captured } = handle('a bare string');

    expect(captured.status).toBe(500);
  });

  it('forwards to Express when the response has already started', () => {
    const { forwarded } = handle(new Error('too late'), true);

    expect(forwarded).toBeInstanceOf(Error);
  });
});

describe('Zod errors reaching the handler directly', () => {
  it('become a 400 with field details', () => {
    let zodError: ZodError;
    try {
      z.object({ email: z.email() }).parse({ email: 'nope' });
      throw new Error('should have thrown');
    } catch (error) {
      zodError = error as ZodError;
    }

    const { captured } = handle(zodError!);

    expect(captured.status).toBe(400);
    expect(captured.body.error.details[0].field).toBe('email');
  });
});

describe('JWT errors', () => {
  it('become a 401', () => {
    const { captured } = handle(new JsonWebTokenError('jwt malformed'));

    expect(captured.status).toBe(401);
    expect(captured.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('body-parser errors', () => {
  it('maps an oversized payload to 413 rather than 500', () => {
    const error = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });

    const { captured } = handle(error);

    expect(captured.status).toBe(413);
    expect(captured.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('maps malformed JSON to 400', () => {
    const error = Object.assign(new SyntaxError('Unexpected token }'), {
      type: 'entity.parse.failed',
      status: 400,
    });

    const { captured } = handle(error);

    expect(captured.status).toBe(400);
    expect(captured.body.error.message).toContain('valid JSON');
  });

  it('maps an unsupported encoding to 400', () => {
    const { captured } = handle(
      Object.assign(new Error('unsupported'), { type: 'encoding.unsupported', status: 415 }),
    );

    expect(captured.status).toBe(400);
  });

  it('ignores an unrelated object that happens to have a type field', () => {
    const { captured } = handle(Object.assign(new Error('boom'), { type: 'something.else' }));

    expect(captured.status).toBe(500);
  });
});

describe('Prisma errors', () => {
  function knownError(code: string, meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError('db failure', {
      code,
      clientVersion: '7.10.0',
      meta,
    });
  }

  it('maps a unique-constraint violation to 409 naming the field', () => {
    const { captured } = handle(knownError('P2002', { target: ['email'] }));

    expect(captured.status).toBe(409);
    expect(captured.body.error.message).toContain('email');
  });

  it('maps a missing record to 404', () => {
    const { captured } = handle(knownError('P2025'));

    expect(captured.status).toBe(404);
  });

  it('maps a foreign-key violation to 400', () => {
    const { captured } = handle(knownError('P2003'));

    expect(captured.status).toBe(400);
  });

  it('collapses an unmapped Prisma code to a generic 500', () => {
    // P1001 (cannot reach the database) is an internal fault, and its message
    // names the database host — it must never be echoed to a client.
    const { captured } = handle(knownError('P1001'));

    expect(captured.status).toBe(500);
    expect(captured.body.error.message).toBe('Internal server error');
  });

  it('maps a validation error to 400 without echoing the query', () => {
    const { captured } = handle(
      new Prisma.PrismaClientValidationError('Argument x is missing in prisma.user.findMany()', {
        clientVersion: '7.10.0',
      }),
    );

    expect(captured.status).toBe(400);
    expect(JSON.stringify(captured.body)).not.toContain('findMany');
  });
});

describe('stack exposure', () => {
  it('includes a stack for a 500 outside production', () => {
    const { captured } = handle(new Error('boom'));

    expect(captured.body.error.stack).toBeDefined();
  });

  it('never includes a stack on a 4xx', () => {
    const { captured } = handle(ApiError.badRequest('nope'));

    expect(captured.body.error.stack).toBeUndefined();
  });

  it('leaks nothing at all in production', () => {
    // env is read once at import time, so the module graph is rebuilt with
    // NODE_ENV=production to exercise the branch that matters most.
    jest.resetModules();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const { errorHandler: productionHandler } =
        require('../../src/middlewares/errorHandler') as typeof import('../../src/middlewares/errorHandler');

      const captured: Captured = { status: 0, body: undefined };
      const res = {
        headersSent: false,
        status(code: number) {
          captured.status = code;
          return this;
        },
        json(payload: unknown) {
          captured.body = payload;
          return this;
        },
      } as unknown as Response;

      productionHandler(
        new Error('connect ECONNREFUSED 10.0.0.5:5432 as user postgres'),
        { method: 'GET', originalUrl: '/api/v1/thing' } as Request,
        res,
        jest.fn() as unknown as NextFunction,
      );

      expect(captured.status).toBe(500);
      expect(captured.body.error.stack).toBeUndefined();
      expect(JSON.stringify(captured.body)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(captured.body)).not.toContain('5432');
    } finally {
      process.env.NODE_ENV = previous;
      jest.resetModules();
    }
  });
});
