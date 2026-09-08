#!/usr/bin/env node
/**
 * Fails on high/critical advisories in the shipped dependency tree.
 *
 * Plain `npm audit --omit=dev` is not usable as a gate here: `@prisma/client`
 * declares the `prisma` CLI as an *optional peer dependency*, so npm keeps the
 * CLI and everything under it in the production graph even though it is a
 * devDependency that is never deployed. Gating on the raw command would fail
 * every run and train people to ignore the result.
 *
 * So each known-and-accepted package is listed below with a reason. Anything
 * else at high or critical severity fails the build.
 *
 *   npm run audit:prod
 */
const { execSync } = require('node:child_process');

/** Packages reachable only through the Prisma CLI, which is not deployed. */
const ACCEPTED = new Map([
  ['prisma', 'Prisma CLI — devDependency, pulled into the graph as an optional peer of @prisma/client'],
  ['@prisma/config', 'Prisma CLI internals'],
  ['deepmerge-ts', 'Transitive dependency of @prisma/config'],
  ['mysql2', 'Prisma CLI driver for MySQL; this project uses PostgreSQL and never loads it'],
]);

const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  try {
    return execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    // npm exits non-zero whenever it finds anything; the report is still on stdout.
    if (error.stdout) return error.stdout;
    throw error;
  }
}

const report = JSON.parse(runAudit());
const found = Object.entries(report.vulnerabilities ?? {});

const blocking = found.filter(
  ([name, details]) => BLOCKING.has(details.severity) && !ACCEPTED.has(name),
);
const accepted = found.filter(
  ([name, details]) => BLOCKING.has(details.severity) && ACCEPTED.has(name),
);

if (accepted.length > 0) {
  console.log('Accepted (not deployed):');
  for (const [name] of accepted) {
    console.log(`  - ${name}: ${ACCEPTED.get(name)}`);
  }
}

// A stale entry means the allowlist is hiding more than it needs to.
const stale = [...ACCEPTED.keys()].filter((name) => !found.some(([found]) => found === name));
if (stale.length > 0) {
  console.log(`\nNote: no longer flagged, so these can be dropped from the allowlist: ${stale.join(', ')}`);
}

if (blocking.length === 0) {
  console.log('\nNo unexpected high or critical advisories in the production tree.');
  process.exit(0);
}

console.error(`\n${blocking.length} unexpected high/critical advisory(ies):`);
for (const [name, details] of blocking) {
  const titles = (details.via ?? [])
    .map((via) => (typeof via === 'string' ? via : via.title))
    .filter(Boolean);
  console.error(`  - ${name} (${details.severity}): ${titles.join('; ') || 'see npm audit'}`);
}
console.error('\nFix them, or add a documented entry to ACCEPTED in scripts/audit-prod.js.');
process.exit(1);
