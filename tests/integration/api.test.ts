/**
 * Drives the real Express app through supertest with only the database mocked.
 * This is the layer the unit tests cannot reach: middleware ordering, security
 * headers, CORS, cookies and the status codes the router actually produces.
 */
jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import fs from 'node:fs/promises';
import request from 'supertest';
import { createApp } from '../../src/app';
import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import { hashPassword } from '../../src/utils/password';
import { signAccessToken } from '../../src/utils/jwt';
import { Role } from '../../src/generated/prisma/enums';
import { notAnArchive, validEpub } from '../helpers/epubFixture';
import { env } from '../../src/config/env';

const db = prismaMockFrom(prismaModule);
const app = createApp();

const USER_ID = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';
const ADMIN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const POST_ID = '11111111-2222-4333-8444-555555555555';
const BOOK_ID = '22222222-3333-4444-8555-666666666666';
const PASSWORD = 'Str0ngPass!23';

let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

/** The row `authenticate` loads for the caller. */
function session(role: (typeof Role)[keyof typeof Role], id = USER_ID) {
  return {
    id,
    email: role === Role.ADMIN ? 'admin@example.com' : 'user@example.com',
    role,
    isActive: true,
    tokensValidFrom: new Date(Date.now() - 60_000),
  };
}

function tokenFor(role: (typeof Role)[keyof typeof Role], id = USER_ID) {
  db.user.findUnique.mockResolvedValue(session(role, id));
  return signAccessToken(id, role);
}

describe('health', () => {
  it('reports ok when the database answers', async () => {
    db.$queryRaw.mockResolvedValue([{ ok: 1 }]);

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('reports 503 when the database is unreachable', async () => {
    db.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });
});

describe('security headers', () => {
  it('sets the expected hardening headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('advertises a rate limit', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['ratelimit']).toBeDefined();
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:3000');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an unlisted origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://evil.example.com');

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('routing', () => {
  it('404s an unknown route in the standard error shape', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('rejects malformed JSON with 400, not 500', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.co",,}');

    expect(res.status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.co', password: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
  });
});

describe('POST /auth/register', () => {
  it('creates a USER and sets an httpOnly refresh cookie', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue({
      id: USER_ID,
      email: 'new@example.com',
      name: 'New',
      role: Role.USER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'New', email: 'new@example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe(Role.USER);
    expect(res.body.data.accessToken).toBeDefined();

    const cookies = res.headers['set-cookie'] as string[] | undefined;
    expect(cookies).toBeDefined();

    const cookie = cookies?.[0] ?? '';
    expect(cookie).toContain('refreshToken=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('never echoes the password back', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue({
      id: USER_ID,
      email: 'new@example.com',
      name: 'New',
      role: Role.USER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'New', email: 'new@example.com', password: PASSWORD });

    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain('$2');
  });

  it('rejects a weak password with per-field details', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'New', email: 'new@example.com', password: 'weak' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
    );
  });
});

describe('POST /auth/login', () => {
  it('returns a token pair', async () => {
    db.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: 'user@example.com',
      name: 'User',
      password: passwordHash,
      role: Role.USER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.refreshToken.create.mockResolvedValue({});

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('rejects a bad password with 401', async () => {
    db.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: 'user@example.com',
      name: 'User',
      password: passwordHash,
      role: Role.USER,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'WrongPass!23' });

    expect(res.status).toBe(401);
  });
});

describe('authentication guard', () => {
  it.each([
    ['GET', '/api/v1/auth/me'],
    ['POST', '/api/v1/posts'],
    ['GET', '/api/v1/users'],
    ['PATCH', '/api/v1/users/me'],
  ])('%s %s requires a token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.token');

    expect(res.status).toBe(401);
  });
});

describe('role gate on /users', () => {
  it('refuses a USER with 403', async () => {
    const token = tokenFor(Role.USER);

    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('admits an ADMIN', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);
    db.user.findMany.mockResolvedValue([]);
    db.user.count.mockResolvedValue(0);

    const res = await request(app)
      .get('/api/v1/users?limit=5')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 5, total: 0 });
  });

  it('rejects an out-of-range limit before touching the database', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);

    const res = await request(app)
      .get('/api/v1/users?limit=99999')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

describe('posts', () => {
  it('serves the public list anonymously', async () => {
    db.post.findMany.mockResolvedValue([]);
    db.post.count.mockResolvedValue(0);

    const res = await request(app).get('/api/v1/posts');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects a non-uuid id with 400', async () => {
    const res = await request(app).get('/api/v1/posts/not-a-uuid');

    expect(res.status).toBe(400);
  });

  it('creates a post owned by the caller, ignoring a supplied authorId', async () => {
    const token = tokenFor(Role.USER);
    db.post.create.mockResolvedValue({ id: POST_ID, authorId: USER_ID });

    const res = await request(app)
      .post('/api/v1/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'A title', content: 'Body', authorId: 'someone-else' });

    expect(res.status).toBe(201);
    expect(db.post.create.mock.calls[0][0].data.authorId).toBe(USER_ID);
  });

  it('refuses to let a stranger edit a post', async () => {
    const token = tokenFor(Role.USER);
    db.post.findUnique.mockResolvedValue({ authorId: 'a-different-owner' });

    const res = await request(app)
      .patch(`/api/v1/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(db.post.update).not.toHaveBeenCalled();
  });

  it('lets an admin edit anyone', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);
    db.post.findUnique.mockResolvedValue({ authorId: 'a-different-owner' });
    db.post.update.mockResolvedValue({ id: POST_ID });

    const res = await request(app)
      .patch(`/api/v1/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Edited by admin' });

    expect(res.status).toBe(200);
  });

  it('returns 204 with no body on delete', async () => {
    const token = tokenFor(Role.USER);
    db.post.findUnique.mockResolvedValue({ authorId: USER_ID });
    db.post.delete.mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/v1/posts/${POST_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('collapses a duplicated query parameter instead of failing', async () => {
    db.post.findMany.mockResolvedValue([]);
    db.post.count.mockResolvedValue(0);

    const res = await request(app).get('/api/v1/posts?limit=5&limit=10');

    expect(res.status).toBe(200);
    expect(db.post.findMany.mock.calls[0][0].take).toBe(10);
  });
});

describe('PATCH /users/me', () => {
  it('applies the rename but ignores a role escalation attempt', async () => {
    const token = tokenFor(Role.USER);
    db.user.update.mockResolvedValue({ id: USER_ID, name: 'Renamed', role: Role.USER });

    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed', role: Role.ADMIN });

    expect(res.status).toBe(200);
    expect(db.user.update.mock.calls[0][0].data).toEqual({ name: 'Renamed' });
  });
});

describe('books', () => {
  /** The multipart request an admin's upload form produces. */
  function upload(token: string, file: Buffer, filename = 'moby.epub') {
    return request(app)
      .post('/api/v1/books')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'Moby Dick')
      .field('published', 'true')
      .attach('file', file, { filename, contentType: 'application/epub+zip' });
  }

  it('requires a session even to list the library', async () => {
    const res = await request(app).get('/api/v1/books');

    expect(res.status).toBe(401);
  });

  it('lets a signed-in reader list published books only', async () => {
    const token = tokenFor(Role.USER);
    db.book.findMany.mockResolvedValue([]);
    db.book.count.mockResolvedValue(0);

    const res = await request(app).get('/api/v1/books').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(db.book.findMany.mock.calls[0][0].where.AND[0]).toEqual({ published: true });
  });

  it('refuses an upload from a USER with 403', async () => {
    const token = tokenFor(Role.USER);

    const res = await upload(token, validEpub('forbidden'));

    expect(res.status).toBe(403);
    expect(db.book.create).not.toHaveBeenCalled();
  });

  it('accepts an upload from an ADMIN', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);
    db.book.findUnique.mockResolvedValue(null);
    db.book.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: BOOK_ID,
      ...data,
    }));

    const res = await upload(token, validEpub('accepted'));

    expect(res.status).toBe(201);
    expect(db.book.create.mock.calls[0][0].data.uploadedById).toBe(ADMIN_ID);
  });

  it('rejects a non-EPUB payload wearing an .epub extension', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);
    db.book.findUnique.mockResolvedValue(null);

    const res = await upload(token, notAnArchive());

    expect(res.status).toBe(400);
    expect(db.book.create).not.toHaveBeenCalled();
  });

  it('rejects a file that is not named .epub', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);

    const res = await upload(token, validEpub('wrong-name'), 'book.pdf');

    expect(res.status).toBe(400);
  });

  it('requires the title metadata field', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);

    const res = await request(app)
      .post('/api/v1/books')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validEpub('no-title'), {
        filename: 'moby.epub',
        contentType: 'application/epub+zip',
      });

    expect(res.status).toBe(400);
    expect(db.book.create).not.toHaveBeenCalled();
  });

  it('refuses a delete from a USER', async () => {
    const token = tokenFor(Role.USER);

    const res = await request(app)
      .delete(`/api/v1/books/${BOOK_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(db.book.delete).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit with 413', async () => {
    const token = tokenFor(Role.ADMIN, ADMIN_ID);
    const oversized = Buffer.concat([validEpub('big'), Buffer.alloc(env.EPUB_MAX_BYTES)]);

    const res = await upload(token, oversized);

    expect(res.status).toBe(413);
    expect(db.book.create).not.toHaveBeenCalled();
  });

  it('streams the stored file back to a reader', async () => {
    const adminToken = tokenFor(Role.ADMIN, ADMIN_ID);
    const bytes = validEpub('streamed');
    db.book.findUnique.mockResolvedValue(null);
    db.book.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: BOOK_ID,
      ...data,
    }));
    await upload(adminToken, bytes);
    const stored = db.book.create.mock.calls[0][0].data;

    const readerToken = tokenFor(Role.USER);
    db.book.findUnique.mockResolvedValue({
      id: BOOK_ID,
      title: 'Moby Dick',
      published: true,
      storageKey: stored.storageKey,
      originalName: 'moby.epub',
      mimeType: 'application/epub+zip',
      sizeBytes: bytes.length,
    });

    const res = await request(app)
      .get(`/api/v1/books/${BOOK_ID}/file?download=true`)
      .set('Authorization', `Bearer ${readerToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/epub+zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="moby-dick.epub"');
    expect(res.headers['cache-control']).toContain('private');
    expect(Buffer.from(res.body).equals(bytes)).toBe(true);
  });

  it('hides an unpublished book from a reader as a 404', async () => {
    const token = tokenFor(Role.USER);
    db.book.findUnique.mockResolvedValue({
      id: BOOK_ID,
      title: 'Draft',
      published: false,
      storageKey: 'x.epub',
    });

    const res = await request(app)
      .get(`/api/v1/books/${BOOK_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
// Uploads land in the temp directory named by tests/setup-env.ts.
afterAll(async () => {
  await fs.rm(env.UPLOAD_DIR, { recursive: true, force: true });
});
