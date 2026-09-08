/**
 * End-to-end verification against a REAL database (Neon).
 * Run migrations and the seed first, then: `npm run e2e`
 *
 * It asserts the authorisation model, not just the happy path: a USER must not
 * be able to read another user's draft, edit someone else's post, list users,
 * or promote themselves to ADMIN.
 */
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * The smallest byte sequence the upload endpoint will accept: a ZIP local file
 * header for a stored `mimetype` entry holding `application/epub+zip`. Written
 * out by hand so the run does not depend on a binary fixture in the repo.
 */
function minimalEpub(marker: string): Buffer {
  const name = Buffer.from('mimetype', 'latin1');
  const content = Buffer.from('application/epub+zip', 'latin1');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 8); // stored, as the OCF spec requires
  header.writeUInt32LE(content.length, 18);
  header.writeUInt32LE(content.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, content, Buffer.from(marker, 'utf8')]);
}

interface ApiResponse {
  status: number;
  // Test-script convenience: responses are probed loosely.
  body: any;
}

async function main(): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}/api/v1`;

  async function call(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<ApiResponse> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  // Unique addresses so repeated runs never collide.
  const stamp = Date.now();
  const aliceEmail = `alice.${stamp}@example.com`;
  const bobEmail = `bob.${stamp}@example.com`;
  const password = 'Str0ngPass!23';

  try {
    section('Health');
    const health = await call('GET', '/health');
    assert('health reports database up', health.body?.database === 'up', JSON.stringify(health.body));

    section('Registration and login');
    const alice = await call('POST', '/auth/register', {
      body: { name: 'Alice', email: aliceEmail, password, role: 'ADMIN' },
    });
    assert('register returns 201', alice.status === 201, JSON.stringify(alice.body));
    assert(
      'self-registration cannot grant ADMIN (role stripped)',
      alice.body?.data?.user?.role === 'USER',
      String(alice.body?.data?.user?.role),
    );
    assert('response never contains a password hash', !JSON.stringify(alice.body).includes('$2'));
    let aliceToken: string = alice.body.data.accessToken;
    const aliceRefresh: string = alice.body.data.refreshToken;
    const aliceId: string = alice.body.data.user.id;

    const bob = await call('POST', '/auth/register', {
      body: { name: 'Bob', email: bobEmail, password },
    });
    const bobToken: string = bob.body.data.accessToken;

    const duplicate = await call('POST', '/auth/register', {
      body: { name: 'Alice again', email: aliceEmail, password },
    });
    assert('duplicate email rejected with 409', duplicate.status === 409, String(duplicate.status));

    const badLogin = await call('POST', '/auth/login', {
      body: { email: aliceEmail, password: 'WrongPass!23' },
    });
    assert('wrong password rejected with 401', badLogin.status === 401);

    const unknownLogin = await call('POST', '/auth/login', {
      body: { email: `ghost.${stamp}@example.com`, password },
    });
    assert(
      'unknown email gives the same message as a wrong password (no enumeration)',
      unknownLogin.body?.error?.message === badLogin.body?.error?.message,
      `${unknownLogin.body?.error?.message} vs ${badLogin.body?.error?.message}`,
    );

    const adminLogin = await call('POST', '/auth/login', {
      body: { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD },
    });
    assert('seeded admin can sign in', adminLogin.status === 200, JSON.stringify(adminLogin.body));
    const adminToken: string = adminLogin.body.data.accessToken;
    const adminId: string = adminLogin.body.data.user.id;
    assert('seeded admin has ADMIN role', adminLogin.body?.data?.user?.role === 'ADMIN');

    section('Posts CRUD (owner)');
    const created = await call('POST', '/posts', {
      token: aliceToken,
      body: { title: 'Alice public post', content: 'Hello world', published: true },
    });
    assert('create post returns 201', created.status === 201, JSON.stringify(created.body));
    const postId: string = created.body.data.post.id;
    assert('author is taken from the session', created.body.data.post.authorId === aliceId);

    const draft = await call('POST', '/posts', {
      token: aliceToken,
      body: { title: 'Alice secret draft', content: 'Not ready', published: false },
    });
    const draftId: string = draft.body.data.post.id;

    const read = await call('GET', `/posts/${postId}`);
    assert('published post is readable anonymously', read.status === 200);

    const updated = await call('PATCH', `/posts/${postId}`, {
      token: aliceToken,
      body: { title: 'Alice public post (edited)' },
    });
    assert('owner can update own post', updated.status === 200);
    assert('update applied', updated.body.data.post.title === 'Alice public post (edited)');

    section('Authorisation boundaries');
    const anonDraft = await call('GET', `/posts/${draftId}`);
    assert('anonymous cannot read a draft (404)', anonDraft.status === 404, String(anonDraft.status));

    const bobReadsDraft = await call('GET', `/posts/${draftId}`, { token: bobToken });
    assert('other USER cannot read the draft (404)', bobReadsDraft.status === 404, String(bobReadsDraft.status));

    const ownerReadsDraft = await call('GET', `/posts/${draftId}`, { token: aliceToken });
    assert('owner CAN read own draft', ownerReadsDraft.status === 200);

    const adminReadsDraft = await call('GET', `/posts/${draftId}`, { token: adminToken });
    assert('admin CAN read any draft', adminReadsDraft.status === 200);

    const anonList = await call('GET', '/posts?limit=100');
    assert(
      'draft never appears in the anonymous list',
      !JSON.stringify(anonList.body).includes(draftId),
    );

    const bobEdits = await call('PATCH', `/posts/${postId}`, {
      token: bobToken,
      body: { title: 'Hijacked' },
    });
    assert('other USER cannot edit the post (403)', bobEdits.status === 403, String(bobEdits.status));

    const bobDeletes = await call('DELETE', `/posts/${postId}`, { token: bobToken });
    assert('other USER cannot delete the post (403)', bobDeletes.status === 403);

    const anonWrite = await call('POST', '/posts', {
      body: { title: 'Anonymous post', content: 'nope' },
    });
    assert('anonymous cannot create a post (401)', anonWrite.status === 401);

    section('Admin-only surface');
    const userLists = await call('GET', '/users', { token: aliceToken });
    assert('USER cannot list users (403)', userLists.status === 403, String(userLists.status));

    const adminLists = await call('GET', '/users?limit=5', { token: adminToken });
    assert('ADMIN can list users', adminLists.status === 200);
    assert('list is paginated', typeof adminLists.body?.meta?.total === 'number');
    assert(
      'listed users never expose password hashes',
      !JSON.stringify(adminLists.body).includes('$2'),
    );

    const selfUpdate = await call('PATCH', '/users/me', {
      token: aliceToken,
      body: { name: 'Alice Renamed', role: 'ADMIN' },
    });
    assert('USER can update own profile', selfUpdate.status === 200, JSON.stringify(selfUpdate.body));
    assert(
      'role is ignored on self-update (no privilege escalation)',
      selfUpdate.body?.data?.user?.role === 'USER',
      String(selfUpdate.body?.data?.user?.role),
    );

    const userDeletes = await call('DELETE', `/users/${aliceId}`, { token: aliceToken });
    assert('USER cannot delete accounts (403)', userDeletes.status === 403);

    section('Admin overrides');
    const adminEdits = await call('PATCH', `/posts/${postId}`, {
      token: adminToken,
      body: { title: 'Edited by admin' },
    });
    assert('ADMIN can edit any post', adminEdits.status === 200, String(adminEdits.status));

    const promote = await call('PATCH', `/users/${aliceId}`, {
      token: adminToken,
      body: { role: 'ADMIN' },
    });
    assert('ADMIN can promote a user', promote.status === 200, JSON.stringify(promote.body));
    assert('promotion persisted', promote.body?.data?.user?.role === 'ADMIN');

    const staleToken = await call('GET', '/auth/me', { token: aliceToken });
    assert(
      'tokens issued before a role change are invalidated (401)',
      staleToken.status === 401,
      String(staleToken.status),
    );

    const staleRefresh = await call('POST', '/auth/refresh', { body: { refreshToken: aliceRefresh } });
    assert(
      'a role change revokes existing refresh tokens too (401)',
      staleRefresh.status === 401,
      String(staleRefresh.status),
    );

    section('EPUB library');
    const bookTitle = `E2E Book ${stamp}`;

    async function uploadBook(
      token: string,
      bytes: Buffer,
      fields: Record<string, string>,
      filename = 'e2e.epub',
    ): Promise<ApiResponse> {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      // Copied into a plain Uint8Array: Node's Buffer is backed by a shared
      // pool, which Blob's type does not accept.
      form.append('file', new Blob([Uint8Array.from(bytes)], { type: 'application/epub+zip' }), filename);

      // No content-type header: fetch sets the multipart boundary itself.
      const res = await fetch(`${base}/books`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }

    const anonBooks = await call('GET', '/books');
    assert('the library is not public (401)', anonBooks.status === 401, String(anonBooks.status));

    const userUpload = await uploadBook(bobToken, minimalEpub('by-user'), { title: 'Nope' });
    assert('USER cannot upload a book (403)', userUpload.status === 403, String(userUpload.status));

    const badUpload = await uploadBook(adminToken, Buffer.from('%PDF-1.7 not a book'), {
      title: bookTitle,
    });
    assert(
      'a non-EPUB payload is rejected whatever its extension (400)',
      badUpload.status === 400,
      String(badUpload.status),
    );

    const epubBytes = minimalEpub(`e2e-${stamp}`);
    const upload = await uploadBook(adminToken, epubBytes, {
      title: bookTitle,
      author: 'E2E Runner',
      published: 'true',
    });
    assert('ADMIN can upload an EPUB (201)', upload.status === 201, JSON.stringify(upload.body));
    const bookId: string = upload.body?.data?.book?.id;
    assert('the upload records a checksum', /^[0-9a-f]{64}$/.test(upload.body?.data?.book?.checksum ?? ''));
    assert(
      'the storage key is never disclosed to the client',
      !JSON.stringify(upload.body).includes('storageKey'),
    );

    const duplicateBook = await uploadBook(adminToken, epubBytes, { title: `${bookTitle} again` });
    assert(
      're-uploading the same file is a 409',
      duplicateBook.status === 409,
      String(duplicateBook.status),
    );

    const readerReads = await call('GET', `/books/${bookId}`, { token: bobToken });
    assert('USER can read a published book', readerReads.status === 200, String(readerReads.status));

    const fileRes = await fetch(`${base}/books/${bookId}/file`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    const downloaded = Buffer.from(await fileRes.arrayBuffer());
    assert('USER can download the file', fileRes.status === 200, String(fileRes.status));
    assert(
      'the bytes come back byte-for-byte',
      downloaded.equals(epubBytes),
      `${downloaded.length} vs ${epubBytes.length}`,
    );
    assert(
      'the file is served as an EPUB',
      fileRes.headers.get('content-type') === 'application/epub+zip',
      String(fileRes.headers.get('content-type')),
    );

    const unpublish = await call('PATCH', `/books/${bookId}`, {
      token: adminToken,
      body: { published: false },
    });
    assert('ADMIN can unpublish a book', unpublish.status === 200, String(unpublish.status));

    const hidden = await call('GET', `/books/${bookId}`, { token: bobToken });
    assert('an unpublished book is a 404 for a USER', hidden.status === 404, String(hidden.status));

    const hiddenFile = await call('GET', `/books/${bookId}/file`, { token: bobToken });
    assert('its file is a 404 too', hiddenFile.status === 404, String(hiddenFile.status));

    const adminSees = await call('GET', `/books/${bookId}`, { token: adminToken });
    assert('ADMIN still sees the unpublished book', adminSees.status === 200, String(adminSees.status));

    const userDeletesBook = await call('DELETE', `/books/${bookId}`, { token: bobToken });
    assert('USER cannot delete a book (403)', userDeletesBook.status === 403, String(userDeletesBook.status));

    const adminDeletesBook = await call('DELETE', `/books/${bookId}`, { token: adminToken });
    assert('ADMIN can delete a book (204)', adminDeletesBook.status === 204, String(adminDeletesBook.status));

    const goneFile = await call('GET', `/books/${bookId}/file`, { token: adminToken });
    assert('the deleted book is gone (404)', goneFile.status === 404, String(goneFile.status));

    section('Refresh token rotation');
    // The promotion above deliberately revoked every session Alice had, so
    // rotation has to be exercised from a fresh login rather than the token
    // issued at registration.
    const aliceRelogin = await call('POST', '/auth/login', {
      body: { email: aliceEmail, password },
    });
    assert(
      'a promoted user can sign in again',
      aliceRelogin.status === 200,
      JSON.stringify(aliceRelogin.body),
    );
    const freshRefresh: string = aliceRelogin.body.data.refreshToken;

    const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken: freshRefresh } });
    assert('refresh issues a new pair', refreshed.status === 200, JSON.stringify(refreshed.body));
    const rotated: string = refreshed.body.data.refreshToken;
    assert('refresh token is rotated (new value)', rotated !== freshRefresh);
    aliceToken = refreshed.body.data.accessToken;

    const replay = await call('POST', '/auth/refresh', { body: { refreshToken: freshRefresh } });
    assert('reusing a rotated refresh token is rejected (401)', replay.status === 401, String(replay.status));

    const afterBreach = await call('POST', '/auth/refresh', { body: { refreshToken: rotated } });
    assert(
      'reuse detection revoked the whole token family (401)',
      afterBreach.status === 401,
      String(afterBreach.status),
    );

    section('Password change');
    const relogin = await call('POST', '/auth/login', { body: { email: bobEmail, password } });
    const bobFresh: string = relogin.body.data.accessToken;
    const bobRefresh: string = relogin.body.data.refreshToken;

    const wrongCurrent = await call('PATCH', '/auth/change-password', {
      token: bobFresh,
      body: { currentPassword: 'NotMyPassword!1', newPassword: 'An0therPass!' },
    });
    assert('wrong current password rejected (401)', wrongCurrent.status === 401);

    const changed = await call('PATCH', '/auth/change-password', {
      token: bobFresh,
      body: { currentPassword: password, newPassword: 'An0therPass!' },
    });
    assert('password change succeeds', changed.status === 200, JSON.stringify(changed.body));

    const oldRefreshAfterChange = await call('POST', '/auth/refresh', {
      body: { refreshToken: bobRefresh },
    });
    assert(
      'password change revokes other sessions (401)',
      oldRefreshAfterChange.status === 401,
      String(oldRefreshAfterChange.status),
    );

    const newSessionWorks = await call('GET', '/auth/me', { token: changed.body.data.accessToken });
    assert('the session that changed the password stays valid', newSessionWorks.status === 200);

    section('Deactivation and admin guard rails');
    const deactivate = await call('PATCH', `/users/${aliceId}`, {
      token: adminToken,
      body: { isActive: false },
    });
    assert('admin can deactivate a user', deactivate.status === 200, JSON.stringify(deactivate.body));

    const deactivatedLogin = await call('POST', '/auth/login', {
      body: { email: aliceEmail, password },
    });
    assert(
      'deactivated user cannot sign in (403)',
      deactivatedLogin.status === 403,
      String(deactivatedLogin.status),
    );

    const selfDemote = await call('PATCH', `/users/${adminId}`, {
      token: adminToken,
      body: { role: 'USER' },
    });
    assert('admin cannot demote themselves (400)', selfDemote.status === 400, String(selfDemote.status));

    const selfDelete = await call('DELETE', `/users/${adminId}`, { token: adminToken });
    assert('admin cannot delete their own account (400)', selfDelete.status === 400, String(selfDelete.status));

    section('Cleanup and cascade');
    const removed = await call('DELETE', `/users/${aliceId}`, { token: adminToken });
    assert('admin can delete a user (204)', removed.status === 204, String(removed.status));

    const orphaned = await prisma.post.count({ where: { authorId: aliceId } });
    assert('posts cascade-delete with their author', orphaned === 0, String(orphaned));
  } finally {
    // Runs even when an assertion above throws. Without this, a failed run
    // leaves its test users in the database and the next run collides with them.
    await prisma.user
      .deleteMany({ where: { email: { in: [aliceEmail, bobEmail] } } })
      .catch(() => undefined);

    server.close();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nE2E run crashed:', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
