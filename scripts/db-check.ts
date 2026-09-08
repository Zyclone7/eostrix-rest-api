/**
 * Explains and verifies DATABASE_URL and DIRECT_URL.
 *
 *   npm run db:check
 *
 * Checks the shape of each URL first (so obvious mistakes are named plainly),
 * then opens a real connection to each and reports what answered. Credentials
 * are never printed.
 */
import 'dotenv/config';
import { Client } from 'pg';

const PLACEHOLDERS = ['USER', 'PASSWORD', 'ep-xxxx', 'REGION', 'replace-me'];

let problems = 0;
let warnings = 0;

function fail(message: string): void {
  problems++;
  console.log(`  FAIL  ${message}`);
}

function warn(message: string): void {
  warnings++;
  console.log(`  WARN  ${message}`);
}

function ok(message: string): void {
  console.log(`  OK    ${message}`);
}

interface Parsed {
  url: URL;
  isPooled: boolean;
  sslmode: string | null;
}

/** Static checks: everything that can be judged without a network call. */
function inspect(label: string, raw: string | undefined, expectPooled: boolean): Parsed | null {
  console.log(`\n${label}`);

  if (!raw || raw.trim() === '') {
    if (label.startsWith('DIRECT_URL')) {
      warn('Not set. Migrations will fall back to DATABASE_URL, which fails on a pooled Neon URL.');
    } else {
      fail('Not set. The server cannot start without it.');
    }
    return null;
  }

  const value = raw.trim();

  if (/^["'].*["']$/.test(value) === false && value.includes(' ')) {
    fail('Contains a space. Wrap the whole value in double quotes.');
  }

  const hit = PLACEHOLDERS.find((token) => value.includes(token));
  if (hit) {
    fail(`Still the example value (contains "${hit}"). Paste your real Neon string.`);
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('Not a parseable URL. It must look like postgresql://user:password@host/dbname?sslmode=require');
    return null;
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    fail(`Scheme is "${url.protocol}" — it must be postgresql://`);
  }
  if (!url.username) fail('No username in the URL.');
  if (!url.password) fail('No password in the URL.');
  if (!url.pathname || url.pathname === '/') fail('No database name after the host (e.g. /neondb).');

  // A password containing @ : / ? # must be percent-encoded or the URL splits wrongly.
  if (url.password && /[@:/?#]/.test(decodeURIComponent(url.password))) {
    warn('The password contains a URL-special character; make sure it is percent-encoded.');
  }

  const isPooled = url.hostname.includes('-pooler');
  const sslmode = url.searchParams.get('sslmode');

  ok(`Host ${url.hostname}, database ${url.pathname.slice(1)}`);

  if (url.hostname.endsWith('.neon.tech')) {
    if (expectPooled && !isPooled) {
      warn('This is the DIRECT host but DATABASE_URL should be the POOLED one (hostname contains "-pooler").');
    }
    if (!expectPooled && isPooled) {
      fail('This is the POOLED host. Migrations cannot run through PgBouncer — use the direct host here (no "-pooler").');
    }
    if (sslmode !== 'require') {
      warn(`sslmode is ${sslmode ?? 'absent'}; Neon expects sslmode=require.`);
    }
  } else {
    ok('Not a Neon host — local or self-hosted Postgres, pooled/direct does not apply.');
  }

  return { url, isPooled, sslmode };
}

/** Live check: can we actually connect, and what is on the other end? */
async function connect(parsed: Parsed | null, raw: string | undefined): Promise<void> {
  if (!parsed || !raw) return;

  const isNeon = parsed.url.hostname.endsWith('.neon.tech');

  // TLS is configured explicitly below, so `sslmode` is stripped from the
  // string handed to pg — left in, pg v8 prints a deprecation notice about
  // how it will reinterpret that parameter in v9. Removing it changes nothing
  // about the connection's security, only the noise.
  const forDriver = new URL(raw.trim());
  forDriver.searchParams.delete('sslmode');

  const client = new Client({
    connectionString: forDriver.toString(),
    // Neon always requires TLS with a verifiable certificate.
    ssl: isNeon ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: 15_000,
  });

  const started = Date.now();
  try {
    await client.connect();
    const { rows } = await client.query<{ db: string; usr: string; version: string }>(
      'SELECT current_database() AS db, current_user AS usr, version() AS version',
    );
    const row = rows[0]!;
    ok(`Connected in ${Date.now() - started}ms as "${row.usr}" to "${row.db}"`);
    ok(`Server: ${row.version.split(',')[0]}`);

    // Advisory locks are what `prisma migrate` takes out, and PgBouncer in
    // transaction mode cannot hold them — so this is the real migration test.
    try {
      await client.query('SELECT pg_advisory_lock(72707369)');
      await client.query('SELECT pg_advisory_unlock(72707369)');
      ok('Advisory locks work — usable for `prisma migrate`.');
    } catch {
      warn('Advisory locks unavailable (typical of a pooled connection) — not usable for `prisma migrate`.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Could not connect: ${message}`);

    if (/password authentication failed/i.test(message)) {
      console.log('        -> Wrong username or password. Reset the role password in the Neon console.');
    } else if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
      console.log('        -> Hostname does not resolve. Check for a typo, or the project may be deleted.');
    } else if (/ETIMEDOUT|ECONNREFUSED/.test(message)) {
      console.log('        -> Nothing accepted the connection. Check the host, port and your network.');
    } else if (/does not exist/i.test(message)) {
      console.log('        -> The database name after the host is wrong.');
    } else if (/SSL|certificate/i.test(message)) {
      console.log('        -> TLS problem. Neon needs ?sslmode=require on the URL.');
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  console.log('Checking database connection strings (credentials are never printed)');

  const pooled = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;

  const parsedPooled = inspect('DATABASE_URL  (runtime queries — should be POOLED)', pooled, true);
  await connect(parsedPooled, pooled);

  const parsedDirect = inspect('DIRECT_URL    (migrations — must be DIRECT)', direct, false);
  await connect(parsedDirect, direct);

  if (pooled && direct && pooled.trim() === direct.trim()) {
    warn('\nDATABASE_URL and DIRECT_URL are identical. On Neon they should differ by the "-pooler" suffix.');
  }

  console.log('\n---');
  if (problems > 0) {
    console.log(`${problems} problem(s), ${warnings} warning(s). Fix the FAIL lines, then re-run.`);
    process.exit(1);
  }
  console.log(
    warnings > 0
      ? `No blocking problems, ${warnings} warning(s). Next: npm run prisma:migrate`
      : 'Both URLs look correct and reachable. Next: npm run prisma:migrate',
  );
}

main().catch((error) => {
  console.error('db:check crashed:', error);
  process.exit(1);
});
