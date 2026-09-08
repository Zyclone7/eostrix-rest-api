import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../../src/middlewares/validate';
import { paginationSchema } from '../../src/utils/pagination';
import { ApiError } from '../../src/utils/ApiError';

interface FakeRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  validatedQuery?: unknown;
  validatedParams?: unknown;
}

function run(schemas: Parameters<typeof validate>[0], req: FakeRequest) {
  const next = jest.fn();
  validate(schemas)(req as unknown as Request, {} as Response, next as unknown as NextFunction);
  return { req, error: next.mock.calls[0]?.[0] as ApiError | undefined };
}

describe('body validation', () => {
  const schema = z.object({ name: z.string().min(2), age: z.coerce.number().int() });

  it('replaces req.body with the parsed result', () => {
    const { req, error } = run({ body: schema }, { body: { name: 'Alice', age: '30' } });

    expect(error).toBeUndefined();
    // Handlers must receive the coerced value, not the raw string.
    expect(req.body).toEqual({ name: 'Alice', age: 30 });
  });

  it('strips unknown keys, which is what blocks mass assignment', () => {
    const { req } = run({ body: schema }, { body: { name: 'Alice', age: 30, role: 'ADMIN' } });

    expect(req.body).not.toHaveProperty('role');
  });

  it('reports a 400 with per-field details', () => {
    const { error } = run({ body: schema }, { body: { name: 'A', age: 'abc' } });

    expect(error).toBeInstanceOf(ApiError);
    expect(error?.statusCode).toBe(400);
    expect(error?.code).toBe('BAD_REQUEST');
    expect(error?.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'name' }),
        expect.objectContaining({ field: 'age' }),
      ]),
    );
  });

  it('names the root when the failure has no path', () => {
    const { error } = run({ body: z.object({}).refine(() => false, 'nope') }, { body: {} });

    expect(error?.details).toEqual([{ field: '(root)', message: 'nope' }]);
  });
});

describe('query validation', () => {
  it('writes to validatedQuery, since Express 5 makes req.query read-only', () => {
    const { req, error } = run({ query: paginationSchema }, { query: { page: '2', limit: '10' } });

    expect(error).toBeUndefined();
    expect(req.validatedQuery).toEqual({ page: 2, limit: 10, sortOrder: 'desc' });
  });

  it('collapses a duplicated parameter to its last value', () => {
    // ?limit=5&limit=100 arrives as an array. Left alone it would fail
    // validation; `hpp` cannot fix it on Express 5, so validate() does.
    const { req, error } = run({ query: paginationSchema }, { query: { limit: ['5', '100'] } });

    expect(error).toBeUndefined();
    expect((req.validatedQuery as { limit: number }).limit).toBe(100);
  });

  it('still enforces bounds on the collapsed value', () => {
    const { error } = run({ query: paginationSchema }, { query: { limit: ['5', '9999'] } });

    expect(error?.statusCode).toBe(400);
  });

  it('leaves a single value untouched', () => {
    const { req } = run({ query: paginationSchema }, { query: { limit: '5' } });

    expect((req.validatedQuery as { limit: number }).limit).toBe(5);
  });

  it('tolerates an empty query', () => {
    const { req, error } = run({ query: paginationSchema }, { query: {} });

    expect(error).toBeUndefined();
    expect((req.validatedQuery as { page: number }).page).toBe(1);
  });
});

describe('params validation', () => {
  const schema = z.object({ id: z.uuid() });

  it('writes to validatedParams', () => {
    const id = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';
    const { req, error } = run({ params: schema }, { params: { id } });

    expect(error).toBeUndefined();
    expect(req.validatedParams).toEqual({ id });
  });

  it('rejects a malformed id before it reaches the database', () => {
    const { error } = run({ params: schema }, { params: { id: 'not-a-uuid' } });

    expect(error?.statusCode).toBe(400);
  });
});

describe('combined schemas', () => {
  it('validates body, query and params together', () => {
    const { req, error } = run(
      {
        body: z.object({ title: z.string() }),
        query: paginationSchema,
        params: z.object({ id: z.uuid() }),
      },
      {
        body: { title: 'Hello' },
        query: { page: '1' },
        params: { id: '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f' },
      },
    );

    expect(error).toBeUndefined();
    expect(req.body).toEqual({ title: 'Hello' });
    expect(req.validatedQuery).toBeDefined();
    expect(req.validatedParams).toBeDefined();
  });

  it('passes through untouched when no schema is given', () => {
    const { req, error } = run({}, { body: { anything: true } });

    expect(error).toBeUndefined();
    expect(req.body).toEqual({ anything: true });
  });
});
