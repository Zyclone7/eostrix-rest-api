jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import * as postService from '../../src/modules/posts/post.service';
import { ApiError } from '../../src/utils/ApiError';
import { Role } from '../../src/generated/prisma/enums';
import type { AuthUser } from '../../src/types/express';

const db = prismaMockFrom(prismaModule);

const OWNER: AuthUser = { id: 'owner-1', email: 'owner@example.com', role: Role.USER };
const STRANGER: AuthUser = { id: 'stranger-1', email: 'other@example.com', role: Role.USER };
const ADMIN: AuthUser = { id: 'admin-1', email: 'admin@example.com', role: Role.ADMIN };

const POST_ID = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';

function post(overrides: Record<string, unknown> = {}) {
  return { id: POST_ID, title: 'T', content: 'C', published: true, authorId: OWNER.id, ...overrides };
}

/** The `where` clause the service handed to findMany. */
function whereFromList() {
  return db.post.findMany.mock.calls[0][0].where;
}

describe('listPosts visibility', () => {
  beforeEach(() => {
    db.post.findMany.mockResolvedValue([]);
    db.post.count.mockResolvedValue(0);
  });

  it('restricts an anonymous caller to published posts', async () => {
    await postService.listPosts({ page: 1, limit: 20, sortOrder: 'desc' } as never, undefined);

    expect(whereFromList().AND[0]).toEqual({ published: true });
  });

  it('lets a USER see published posts plus their own', async () => {
    await postService.listPosts({ page: 1, limit: 20, sortOrder: 'desc' } as never, OWNER);

    expect(whereFromList().AND[0]).toEqual({
      OR: [{ published: true }, { authorId: OWNER.id }],
    });
  });

  it('applies no visibility restriction for an ADMIN', async () => {
    await postService.listPosts({ page: 1, limit: 20, sortOrder: 'desc' } as never, ADMIN);

    expect(whereFromList().AND[0]).toEqual({});
  });

  it('scopes ?mine=true to the caller', async () => {
    await postService.listPosts(
      { page: 1, limit: 20, sortOrder: 'desc', mine: true } as never,
      OWNER,
    );

    expect(whereFromList().AND).toContainEqual({ authorId: OWNER.id });
  });

  it('rejects ?mine=true without a session', async () => {
    await expect(
      postService.listPosts({ page: 1, limit: 20, sortOrder: 'desc', mine: true } as never, undefined),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 401 }));
  });

  it('only ever orders by a whitelisted column', async () => {
    await postService.listPosts(
      { page: 1, limit: 20, sortOrder: 'asc', sortBy: 'author.password' } as never,
      ADMIN,
    );

    expect(db.post.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
  });

  it('paginates', async () => {
    db.post.count.mockResolvedValue(42);

    const result = await postService.listPosts(
      { page: 2, limit: 20, sortOrder: 'desc' } as never,
      ADMIN,
    );

    expect(db.post.findMany.mock.calls[0][0]).toMatchObject({ skip: 20, take: 20 });
    expect(result.meta).toMatchObject({ page: 2, total: 42, totalPages: 3, hasNextPage: true });
  });

  it('never selects the author password', async () => {
    await postService.listPosts({ page: 1, limit: 20, sortOrder: 'desc' } as never, ADMIN);

    const select = db.post.findMany.mock.calls[0][0].select;
    expect(select.author.select.password).toBeUndefined();
  });
});

describe('getPostById', () => {
  it('404s when the post does not exist', async () => {
    db.post.findUnique.mockResolvedValue(null);

    await expect(postService.getPostById(POST_ID, ADMIN)).rejects.toThrow(ApiError);
  });

  it('serves a published post to anyone', async () => {
    db.post.findUnique.mockResolvedValue(post());

    await expect(postService.getPostById(POST_ID, undefined)).resolves.toMatchObject({ id: POST_ID });
  });

  it.each([
    ['an anonymous caller', undefined],
    ['a different USER', STRANGER],
  ])('hides an unpublished post from %s behind a 404, not a 403', async (_label, actor) => {
    db.post.findUnique.mockResolvedValue(post({ published: false }));

    // 403 would confirm the id exists; 404 reveals nothing.
    await expect(postService.getPostById(POST_ID, actor as AuthUser)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it.each([
    ['the owner', OWNER],
    ['an admin', ADMIN],
  ])('shows an unpublished post to %s', async (_label, actor) => {
    db.post.findUnique.mockResolvedValue(post({ published: false }));

    await expect(postService.getPostById(POST_ID, actor)).resolves.toMatchObject({ id: POST_ID });
  });
});

describe('createPost', () => {
  it('takes the author from the session, ignoring any body value', async () => {
    db.post.create.mockResolvedValue(post());

    await postService.createPost(
      { title: 'T', content: 'C', published: false, authorId: STRANGER.id } as never,
      OWNER.id,
    );

    expect(db.post.create.mock.calls[0][0].data.authorId).toBe(OWNER.id);
  });
});

describe('updatePost', () => {
  it('lets the owner update', async () => {
    db.post.findUnique.mockResolvedValue({ authorId: OWNER.id });
    db.post.update.mockResolvedValue(post());

    await expect(postService.updatePost(POST_ID, { title: 'New' }, OWNER)).resolves.toBeDefined();
  });

  it('lets an admin update anyone', async () => {
    db.post.findUnique.mockResolvedValue({ authorId: OWNER.id });
    db.post.update.mockResolvedValue(post());

    await expect(postService.updatePost(POST_ID, { title: 'New' }, ADMIN)).resolves.toBeDefined();
  });

  it('refuses a stranger with 403 and performs no write', async () => {
    db.post.findUnique.mockResolvedValue({ authorId: OWNER.id });

    await expect(postService.updatePost(POST_ID, { title: 'New' }, STRANGER)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(db.post.update).not.toHaveBeenCalled();
  });

  it('404s for a missing post before checking ownership', async () => {
    db.post.findUnique.mockResolvedValue(null);

    await expect(postService.updatePost(POST_ID, { title: 'New' }, OWNER)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

describe('deletePost', () => {
  it('lets the owner delete', async () => {
    db.post.findUnique.mockResolvedValue({ authorId: OWNER.id });
    db.post.delete.mockResolvedValue(post());

    await expect(postService.deletePost(POST_ID, OWNER)).resolves.toBeUndefined();
    expect(db.post.delete).toHaveBeenCalledWith({ where: { id: POST_ID } });
  });

  it('refuses a stranger and performs no delete', async () => {
    db.post.findUnique.mockResolvedValue({ authorId: OWNER.id });

    await expect(postService.deletePost(POST_ID, STRANGER)).rejects.toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(db.post.delete).not.toHaveBeenCalled();
  });
});
