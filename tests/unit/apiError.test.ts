import { ApiError } from '../../src/utils/ApiError';

describe('construction', () => {
  it('carries status, message, code and details', () => {
    const error = new ApiError(418, 'Teapot', 'TEAPOT', { brew: false });

    expect(error.statusCode).toBe(418);
    expect(error.message).toBe('Teapot');
    expect(error.code).toBe('TEAPOT');
    expect(error.details).toEqual({ brew: false });
  });

  it('defaults the code when none is given', () => {
    expect(new ApiError(500, 'Boom').code).toBe('ERROR');
  });

  it('is a real Error, so instanceof and stacks work after transpilation', () => {
    const error = new ApiError(400, 'Bad');

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeDefined();
    expect(error.isOperational).toBe(true);
  });
});

describe('factories', () => {
  it.each([
    ['badRequest', ApiError.badRequest(), 400, 'BAD_REQUEST'],
    ['unauthorized', ApiError.unauthorized(), 401, 'UNAUTHORIZED'],
    ['forbidden', ApiError.forbidden(), 403, 'FORBIDDEN'],
    ['notFound', ApiError.notFound(), 404, 'NOT_FOUND'],
    ['conflict', ApiError.conflict(), 409, 'CONFLICT'],
    ['tooManyRequests', ApiError.tooManyRequests(), 429, 'TOO_MANY_REQUESTS'],
    ['internal', ApiError.internal(), 500, 'INTERNAL_SERVER_ERROR'],
  ])('%s maps to %i', (_name, error, status, code) => {
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(code);
    // Every factory has a sensible default message.
    expect(error.message.length).toBeGreaterThan(0);
  });

  it('accepts an overriding message', () => {
    expect(ApiError.forbidden('Not yours').message).toBe('Not yours');
    expect(ApiError.notFound('No such post').message).toBe('No such post');
  });

  it('carries validation details on badRequest', () => {
    const error = ApiError.badRequest('Validation failed', [{ field: 'email' }]);

    expect(error.details).toEqual([{ field: 'email' }]);
  });
});
