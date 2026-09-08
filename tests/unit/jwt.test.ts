import jwt from 'jsonwebtoken';
import {
  expiryDateOf,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/utils/jwt';
import { ApiError } from '../../src/utils/ApiError';
import { Role } from '../../src/generated/prisma/enums';

const USER_ID = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';

describe('access tokens', () => {
  it('round-trips the subject and role', () => {
    const payload = verifyAccessToken(signAccessToken(USER_ID, Role.ADMIN));

    expect(payload.sub).toBe(USER_ID);
    expect(payload.role).toBe(Role.ADMIN);
    expect(payload.type).toBe('access');
  });

  it('rejects a tampered signature', () => {
    const token = signAccessToken(USER_ID, Role.USER);
    const tampered = `${token.slice(0, -3)}aaa`;

    expect(() => verifyAccessToken(tampered)).toThrow(ApiError);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ role: Role.ADMIN, type: 'access' }, 'some-other-secret-value-here', {
      subject: USER_ID,
      issuer: 'express-ts-crud-api',
      audience: 'express-ts-crud-api:client',
      expiresIn: '15m',
    });

    expect(() => verifyAccessToken(forged)).toThrow('Invalid access token');
  });

  it('rejects a token from a different issuer', () => {
    const foreign = jwt.sign(
      { role: Role.ADMIN, type: 'access' },
      process.env.JWT_ACCESS_SECRET!,
      {
        subject: USER_ID,
        issuer: 'some-other-service',
        audience: 'express-ts-crud-api:client',
        expiresIn: '15m',
      },
    );

    expect(() => verifyAccessToken(foreign)).toThrow(ApiError);
  });

  it('reports an expired token with a distinguishable code', () => {
    const expired = jwt.sign({ role: Role.USER, type: 'access' }, process.env.JWT_ACCESS_SECRET!, {
      subject: USER_ID,
      issuer: 'express-ts-crud-api',
      audience: 'express-ts-crud-api:client',
      expiresIn: '-1s',
    });

    // The client needs to tell "expired, go refresh" apart from "invalid, sign in again".
    expect(() => verifyAccessToken(expired)).toThrow(
      expect.objectContaining({ code: 'TOKEN_EXPIRED', statusCode: 401 }),
    );
  });
});

describe('token type confusion', () => {
  it('will not accept a refresh token where an access token is expected', () => {
    const { token } = signRefreshToken(USER_ID);

    // Even though both are valid JWTs, the secrets and the `type` claim differ.
    expect(() => verifyAccessToken(token)).toThrow(ApiError);
  });

  it('will not accept an access token where a refresh token is expected', () => {
    const access = signAccessToken(USER_ID, Role.USER);

    expect(() => verifyRefreshToken(access)).toThrow(ApiError);
  });

  it('rejects a correctly-signed token carrying the wrong type claim', () => {
    // Signed with the real access secret, but claiming to be a refresh token.
    const mislabelled = jwt.sign({ type: 'refresh' }, process.env.JWT_ACCESS_SECRET!, {
      subject: USER_ID,
      issuer: 'express-ts-crud-api',
      audience: 'express-ts-crud-api:client',
      expiresIn: '15m',
    });

    expect(() => verifyAccessToken(mislabelled)).toThrow(ApiError);
  });
});

describe('refresh tokens', () => {
  it('issues a unique jti per token', () => {
    const first = signRefreshToken(USER_ID);
    const second = signRefreshToken(USER_ID);

    expect(first.jti).not.toBe(second.jti);
    expect(first.token).not.toBe(second.token);
    expect(verifyRefreshToken(first.token).jti).toBe(first.jti);
  });

  it('reports an expired refresh token with its own code', () => {
    const expired = jwt.sign({ type: 'refresh' }, process.env.JWT_REFRESH_SECRET!, {
      subject: USER_ID,
      jwtid: 'abc',
      issuer: 'express-ts-crud-api',
      audience: 'express-ts-crud-api:client',
      expiresIn: '-1s',
    });

    expect(() => verifyRefreshToken(expired)).toThrow(
      expect.objectContaining({ code: 'REFRESH_TOKEN_EXPIRED' }),
    );
  });
});

describe('hashToken', () => {
  it('is deterministic and hides the original token', () => {
    const { token } = signRefreshToken(USER_ID);
    const digest = hashToken(token);

    expect(digest).toBe(hashToken(token));
    expect(digest).toHaveLength(64);
    // The stored value must not contain the token it stands for.
    expect(digest).not.toContain(token);
  });

  it('produces different digests for different tokens', () => {
    expect(hashToken(signRefreshToken(USER_ID).token)).not.toBe(
      hashToken(signRefreshToken(USER_ID).token),
    );
  });
});

describe('expiryDateOf', () => {
  it('derives the expiry from the token itself', () => {
    const { token } = signRefreshToken(USER_ID);
    const expiry = expiryDateOf(token);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    expect(expiry.getTime() - Date.now()).toBeGreaterThan(sevenDays - 60_000);
    expect(expiry.getTime() - Date.now()).toBeLessThanOrEqual(sevenDays);
  });

  it('throws when the token carries no exp claim', () => {
    const noExpiry = jwt.sign({ type: 'refresh' }, process.env.JWT_REFRESH_SECRET!);

    expect(() => expiryDateOf(noExpiry)).toThrow(ApiError);
  });
});
