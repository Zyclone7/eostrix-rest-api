import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration.
 * - `datasource.url` is used by the CLI (migrate, db push, introspect). Neon
 *   pools through PgBouncer, which cannot run migrations, so this points at
 *   the DIRECT (non-pooled) URL when one is provided.
 * - Runtime queries do NOT read this file; they go through the driver adapter
 *   configured in src/config/prisma.ts using the pooled DATABASE_URL.
 * - Prisma 7 no longer auto-loads .env, hence the dotenv import above.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || '',
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
