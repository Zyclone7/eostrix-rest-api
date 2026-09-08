/**
 * Runs before any module is imported, so `src/config/env.ts` sees a valid
 * environment. These are assigned rather than defaulted: dotenv does not
 * override existing variables, which guarantees a developer's real .env
 * (including a live Neon URL) can never leak into a unit-test run.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '4001';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/testdb';
process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret-value-32-chars-min!!';
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret-value-32-chars-min!';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.CORS_ORIGINS = 'http://localhost:3000,http://localhost:5173';
// The floor allowed by the env schema — keeps bcrypt work low so the suite is fast.
process.env.BCRYPT_ROUNDS = '10';
// Uploads are redirected into the OS temp directory, so a test run can never
// write into (or delete from) the developer's real ./uploads folder.
process.env.UPLOAD_DIR = require('node:path').join(
  require('node:os').tmpdir(),
  'express-ts-api-test-uploads',
);
// A small ceiling keeps the "file too large" test cheap.
process.env.EPUB_MAX_BYTES = String(1024 * 1024);
process.env.SEED_ADMIN_EMAIL = 'admin@example.com';
process.env.SEED_ADMIN_PASSWORD = 'Admin123!pass';
