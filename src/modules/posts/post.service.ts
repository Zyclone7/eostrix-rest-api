import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { buildMeta, resolveSort, skipTake } from '../../utils/pagination';
import { Role } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthUser } from '../../types/express';
import type { CreatePostInput, ListPostsQuery, UpdatePostInput } from './post.schema';

const SORTABLE = ['createdAt', 'updatedAt', 'title'] as const;

const postSelect = {
  id: true,
  title: true,
  content: true,
  published: true,
  authorId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true, role: true } },
} as const;

/**
 * Builds the visibility filter for a list request.
 *
 * This is the heart of the read authorisation model, expressed once:
 *   - anonymous  → published posts only
 *   - USER       → published posts, plus every post they authored
 *   - ADMIN      → everything
 */
function visibilityFilter(actor: AuthUser | undefined): Prisma.PostWhereInput {
  if (actor?.role === Role.ADMIN) return {};
  if (actor) return { OR: [{ published: true }, { authorId: actor.id }] };
  return { published: true };
}

export async function listPosts(queryInput: ListPostsQuery, actor: AuthUser | undefined) {
  const { page, limit, sortOrder, search, published, authorId, mine } = queryInput;

  if (mine && !actor) throw ApiError.unauthorized('Sign in to list your own posts');

  const where: Prisma.PostWhereInput = {
    AND: [
      visibilityFilter(actor),
      ...(published !== undefined ? [{ published }] : []),
      ...(authorId ? [{ authorId }] : []),
      ...(mine && actor ? [{ authorId: actor.id }] : []),
      ...(search
        ? [
            {
              OR: [
                { title: { contains: search, mode: 'insensitive' as const } },
                { content: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const orderBy = { [resolveSort(queryInput.sortBy, SORTABLE, 'createdAt')]: sortOrder };

  const [items, total] = await prisma.$transaction([
    prisma.post.findMany({ where, orderBy, ...skipTake(page, limit), select: postSelect }),
    prisma.post.count({ where }),
  ]);

  return { items, meta: buildMeta(total, page, limit) };
}

export async function getPostById(id: string, actor: AuthUser | undefined) {
  const post = await prisma.post.findUnique({ where: { id }, select: postSelect });
  if (!post) throw ApiError.notFound('Post not found');

  const isOwner = actor?.id === post.authorId;
  const isAdmin = actor?.role === Role.ADMIN;

  // An unpublished post is a 404 rather than a 403 for outsiders: confirming
  // that a hidden id exists is itself a disclosure.
  if (!post.published && !isOwner && !isAdmin) throw ApiError.notFound('Post not found');

  return post;
}

export function createPost(input: CreatePostInput, authorId: string) {
  return prisma.post.create({ data: { ...input, authorId }, select: postSelect });
}

export async function updatePost(id: string, input: UpdatePostInput, actor: AuthUser) {
  await assertOwnership(id, actor);
  return prisma.post.update({ where: { id }, data: input, select: postSelect });
}

export async function deletePost(id: string, actor: AuthUser): Promise<void> {
  await assertOwnership(id, actor);
  await prisma.post.delete({ where: { id } });
}

/**
 * Fetches the row's owner and checks it against the caller. Doing this as an
 * explicit read (rather than a `where: { id, authorId }` update) lets us
 * distinguish "does not exist" from "not yours" for accurate status codes.
 */
async function assertOwnership(id: string, actor: AuthUser): Promise<void> {
  const post = await prisma.post.findUnique({ where: { id }, select: { authorId: true } });
  if (!post) throw ApiError.notFound('Post not found');

  if (actor.role !== Role.ADMIN && post.authorId !== actor.id) {
    throw ApiError.forbidden('You can only modify your own posts');
  }
}
