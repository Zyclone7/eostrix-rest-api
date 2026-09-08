import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { hashPassword } from '../../utils/password';
import { buildMeta, resolveSort, skipTake } from '../../utils/pagination';
import { publicUserSelect } from '../auth/auth.service';
import { Role } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import type {
  AdminUpdateUserInput,
  CreateUserInput,
  ListUsersQuery,
  UpdateProfileInput,
} from './user.schema';

const SORTABLE = ['createdAt', 'updatedAt', 'name', 'email', 'role'] as const;

export async function listUsers(query: ListUsersQuery) {
  const { page, limit, sortOrder, search, role, isActive } = query;

  const where: Prisma.UserWhereInput = {
    ...(role ? { role } : {}),
    ...(isActive !== undefined ? { isActive } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const orderBy = { [resolveSort(query.sortBy, SORTABLE, 'createdAt')]: sortOrder };

  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      orderBy,
      ...skipTake(page, limit),
      select: { ...publicUserSelect, _count: { select: { posts: true } } },
    }),
    prisma.user.count({ where }),
  ]);

  return { items, meta: buildMeta(total, page, limit) };
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { ...publicUserSelect, _count: { select: { posts: true } } },
  });
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

export async function createUser(input: CreateUserInput) {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  return prisma.user.create({
    data: { ...input, password: await hashPassword(input.password) },
    select: publicUserSelect,
  });
}

/** Self-service profile update. Cannot touch role or activation. */
export async function updateProfile(userId: string, input: UpdateProfileInput) {
  if (input.email) await assertEmailAvailable(input.email, userId);
  return prisma.user.update({ where: { id: userId }, data: input, select: publicUserSelect });
}

export async function adminUpdateUser(
  targetId: string,
  input: AdminUpdateUserInput,
  actingAdminId: string,
) {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, role: true },
  });
  if (!target) throw ApiError.notFound('User not found');

  // Guard rails against an admin locking themselves out of the system.
  if (target.id === actingAdminId) {
    if (input.role && input.role !== Role.ADMIN) {
      throw ApiError.badRequest('You cannot remove your own admin role');
    }
    if (input.isActive === false) {
      throw ApiError.badRequest('You cannot deactivate your own account');
    }
  }

  if (target.role === Role.ADMIN && (input.role === Role.USER || input.isActive === false)) {
    await assertNotLastAdmin(targetId);
  }

  if (input.email) await assertEmailAvailable(input.email, targetId);

  const user = await prisma.user.update({
    where: { id: targetId },
    data: input,
    select: publicUserSelect,
  });

  // A demotion or deactivation must take effect now, not when the token expires.
  if (input.role !== undefined || input.isActive === false) {
    await prisma.$transaction([
      prisma.user.update({ where: { id: targetId }, data: { tokensValidFrom: new Date() } }),
      prisma.refreshToken.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  return user;
}

export async function deleteUser(targetId: string, actingAdminId: string) {
  if (targetId === actingAdminId) {
    throw ApiError.badRequest('You cannot delete your own account');
  }

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, role: true },
  });
  if (!target) throw ApiError.notFound('User not found');

  if (target.role === Role.ADMIN) await assertNotLastAdmin(targetId);

  // Posts and refresh tokens cascade via the schema's onDelete rules.
  await prisma.user.delete({ where: { id: targetId } });
}

async function assertEmailAvailable(email: string, exceptUserId: string): Promise<void> {
  const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (owner && owner.id !== exceptUserId) {
    throw ApiError.conflict('That email address is already in use');
  }
}

/** The system must always retain at least one active administrator. */
async function assertNotLastAdmin(excludingUserId: string): Promise<void> {
  const otherAdmins = await prisma.user.count({
    where: { role: Role.ADMIN, isActive: true, id: { not: excludingUserId } },
  });
  if (otherAdmins === 0) {
    throw ApiError.badRequest('The last active administrator cannot be removed or demoted');
  }
}
