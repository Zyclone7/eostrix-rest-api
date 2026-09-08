import crypto from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { globalLimiter } from './middlewares/rateLimiter';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { ApiError } from './utils/ApiError';
import routes from './routes';

export function createApp(): Express {
  const app = express();

  // Behind a proxy (Render, Railway, Fly, nginx) req.ip must come from
  // X-Forwarded-For, otherwise every client shares the proxy's address and
  // the rate limiter becomes a single global bucket.
  app.set('trust proxy', env.isProduction ? 1 : false);
  app.disable('x-powered-by');

  // --- Security headers ----------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: env.isProduction ? [] : null,
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // --- CORS ----------------------------------------------------------------
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // No Origin header: same-origin, curl, or a mobile app — allowed.
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      callback(new ApiError(403, 'Origin not allowed by CORS', 'CORS_REJECTED'));
    },
    credentials: true, // required for the refresh-token cookie
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400,
  };
  app.use(cors(corsOptions));

  // --- Body parsing --------------------------------------------------------
  // The size cap is a denial-of-service control: without it a single request
  // can pin the event loop parsing an arbitrarily large payload.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());

  // NOTE: duplicated query parameters (?role=USER&role=ADMIN) are collapsed in
  // the `validate` middleware rather than by `hpp`, which cannot work on
  // Express 5 — see the comment on collapseDuplicates().

  app.use(compression());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.headers['x-request-id']?.toString() ?? crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
    }),
  );

  app.use(globalLimiter);

  // --- Routes --------------------------------------------------------------
  app.use('/api/v1', routes);

  // --- Tail middleware (order matters) ------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
