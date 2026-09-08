/**
 * Unit tests only — they never touch Postgres. `src/config/prisma` is mocked
 * wherever a service needs it, so the suite runs identically on a laptop with
 * no database and in CI. Database-backed verification lives in scripts/e2e.ts.
 *
 * Written as CommonJS rather than TypeScript so Jest does not need `ts-node`
 * purely to read its own configuration.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/generated/**',
    '!src/server.ts',
    '!src/types/**',
    '!src/config/logger.ts',
  ],
  coverageThreshold: {
    global: { statements: 85, branches: 75, functions: 78, lines: 85 },
  },
  testTimeout: 20000,
};
