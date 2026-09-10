import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { buildMeta, resolveSort, skipTake } from '../../utils/pagination';
import { publicUserSelect } from '../auth/auth.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ListUsersQuery } from '../users/user.schema';
import type {
  AssignMembersInput,
  CreateDepartmentInput,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from './department.schema';

const SORTABLE = ['createdAt', 'updatedAt', 'name', 'code'] as const;
const MEMBER_SORTABLE = ['createdAt', 'updatedAt', 'name', 'email', 'role'] as const;

/** `_count.users` is the headline figure callers want: how big is this team. */
const departmentSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { users: true } },
} as const;

export async function listDepartments(query: ListDepartmentsQuery) {
  const { page, limit, sortOrder, search, isActive } = query;

  const where: Prisma.DepartmentWhereInput = {
    ...(isActive !== undefined ? { isActive } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { code: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const orderBy = { [resolveSort(query.sortBy, SORTABLE, 'name')]: sortOrder };

  const [items, total] = await prisma.$transaction([
    prisma.department.findMany({
      where,
      orderBy,
      ...skipTake(page, limit),
      select: departmentSelect,
    }),
    prisma.department.count({ where }),
  ]);

  return { items, meta: buildMeta(total, page, limit) };
}

export async function getDepartmentById(id: string) {
  const department = await prisma.department.findUnique({ where: { id }, select: departmentSelect });
  if (!department) throw ApiError.notFound('Department not found');
  return department;
}

export async function createDepartment(input: CreateDepartmentInput) {
  await assertNameAndCodeFree(input.name, input.code);
  return prisma.department.create({ data: input, select: departmentSelect });
}

export async function updateDepartment(id: string, input: UpdateDepartmentInput) {
  const existing = await prisma.department.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw ApiError.notFound('Department not found');

  await assertNameAndCodeFree(input.name, input.code, id);

  return prisma.department.update({ where: { id }, data: input, select: departmentSelect });
}

/**
 * Deleting a department that still has members is refused rather than silently
 * orphaning them: the foreign key is `onDelete: Restrict`, so this turns what
 * would be a raw database error into a 409 that says what to do about it.
 */
export async function deleteDepartment(id: string): Promise<void> {
  const department = await prisma.department.findUnique({
    where: { id },
    select: { id: true, _count: { select: { users: true } } },
  });
  if (!department) throw ApiError.notFound('Department not found');

  if (department._count.users > 0) {
    throw ApiError.conflict(
      `This department still has ${department._count.users} member(s). Reassign them before deleting it.`,
    );
  }

  await prisma.department.delete({ where: { id } });
}

/** The roster: every user placed in this department, paginated and searchable. */
export async function listDepartmentMembers(id: string, query: ListUsersQuery) {
  await assertDepartmentExists(id);

  const { page, limit, sortOrder, search, role, isActive } = query;

  const where: Prisma.UserWhereInput = {
    departmentId: id,
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

  const orderBy = { [resolveSort(query.sortBy, MEMBER_SORTABLE, 'name')]: sortOrder };

  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({ where, orderBy, ...skipTake(page, limit), select: publicUserSelect }),
    prisma.user.count({ where }),
  ]);

  return { items, meta: buildMeta(total, page, limit) };
}

/** Bulk placement, e.g. moving a whole intake into IT in one call. */
export async function assignMembers(id: string, input: AssignMembersInput) {
  const department = await prisma.department.findUnique({
    where: { id },
    select: { id: true, isActive: true },
  });
  if (!department) throw ApiError.notFound('Department not found');
  if (!department.isActive) {
    throw ApiError.badRequest('This department is inactive and cannot take new members');
  }

  const userIds = [...new Set(input.userIds)];

  // Every id is checked up front so one bad id fails the whole call rather
  // than half-applying it.
  const found = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true },
  });
  if (found.length !== userIds.length) {
    const missing = userIds.filter((userId) => !found.some((user) => user.id === userId));
    throw ApiError.notFound(`Unknown user id(s): ${missing.join(', ')}`);
  }

  const { count } = await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { departmentId: id },
  });

  return { assigned: count };
}

/** Removes one user from the department, leaving the account unplaced. */
export async function removeMember(id: string, userId: string): Promise<void> {
  await assertDepartmentExists(id);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, departmentId: true },
  });
  if (!user) throw ApiError.notFound('User not found');
  if (user.departmentId !== id) {
    throw ApiError.badRequest('That user is not a member of this department');
  }

  await prisma.user.update({ where: { id: userId }, data: { departmentId: null } });
}

/**
 * Guard used by the user module: a user may only be placed in a department
 * that exists and is still open.
 */
export async function assertAssignable(departmentId: string): Promise<void> {
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, isActive: true },
  });
  if (!department) throw ApiError.badRequest('Unknown department');
  if (!department.isActive) {
    throw ApiError.badRequest('This department is inactive and cannot take new members');
  }
}

async function assertDepartmentExists(id: string): Promise<void> {
  const department = await prisma.department.findUnique({ where: { id }, select: { id: true } });
  if (!department) throw ApiError.notFound('Department not found');
}

async function assertNameAndCodeFree(
  name: string | undefined,
  code: string | undefined,
  exceptId?: string,
): Promise<void> {
  if (!name && !code) return;

  const clashes = await prisma.department.findMany({
    where: {
      OR: [...(name ? [{ name }] : []), ...(code ? [{ code }] : [])],
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { name: true, code: true },
  });

  if (name && clashes.some((row) => row.name === name)) {
    throw ApiError.conflict('A department with this name already exists');
  }
  if (code && clashes.some((row) => row.code === code)) {
    throw ApiError.conflict('A department with this code already exists');
  }
}
