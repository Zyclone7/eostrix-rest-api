/**
 * Database-free smoke test of the HTTP layer: security headers, 404 handling,
 * validation, auth guards, CORS and body limits.  `npm run smoke`
 *
 * Every request here must be rejected before it reaches a service that touches
 * the database, so this passes identically with or without a live connection
 * and never writes anything.
 */
import { createApp } from '../src/app';

const app = createApp();
const server = app.listen(0, async () => {
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/v1`;
  let failures = 0;

  const check = async (name: string, expected: number, path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    const ok = res.status === expected;
    if (!ok) failures++;
    const body = await res.text();
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name}  -> ${res.status} (want ${expected}) ${ok ? '' : body.slice(0, 160)}`,
    );
    return res;
  };

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const r = await check('unknown route -> 404', 404, '/nope');

  const headerChecks: Array<[string, boolean]> = [
    ['content-security-policy set', !!r.headers.get('content-security-policy')],
    ['x-content-type-options nosniff', r.headers.get('x-content-type-options') === 'nosniff'],
    ['x-powered-by hidden', r.headers.get('x-powered-by') === null],
    ['x-request-id set', !!r.headers.get('x-request-id')],
    ['rate limit advertised', !!r.headers.get('ratelimit')],
  ];
  for (const [name, passed] of headerChecks) {
    if (!passed) failures++;
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  }

  await check('protected route without token -> 401', 401, '/auth/me');
  await check('protected route with junk token -> 401', 401, '/auth/me', {
    headers: { authorization: 'Bearer not.a.real.token' },
  });
  await check('admin list without token -> 401', 401, '/users');
  await check('register with weak password -> 400', 400, '/auth/register', json({
    name: 'A', email: 'not-an-email', password: 'short',
  }));
  // NOTE: nothing here may reach a service that writes. An earlier version of
  // this file POSTed to /auth/register to show that `role` is stripped, which
  // quietly created a real user once a live database was configured. Role
  // stripping is covered without side effects by tests/unit/schemas.test.ts
  // and tests/integration/api.test.ts, where Prisma is mocked.
  await check('bad uuid param -> 400', 400, '/posts/not-a-uuid');
  await check('book library without token -> 401', 401, '/books');
  await check('book upload without token -> 401', 401, '/books', { method: 'POST' });
  await check('malformed JSON -> 400', 400, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email": "a@b.co",,}',
  });
  await check('unlisted CORS origin -> 403', 403, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
    body: JSON.stringify({ email: 'a@b.co', password: 'x' }),
  });
  await check('oversized body -> 413', 413, '/auth/login', json({ email: 'a@b.co', password: 'x'.repeat(200_000) }));

  console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
});
