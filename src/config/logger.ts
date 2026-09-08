import pino from 'pino';
import { env } from './env';

export const logger = pino({
  level: env.isProduction ? 'info' : 'debug',
  // Pretty output locally; newline-delimited JSON in production.
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  // Belt-and-braces: never let a secret reach the log sink.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.confirmPassword',
      '*.currentPassword',
      '*.newPassword',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
});
