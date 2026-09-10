import { z } from 'zod';
import { emailSchema, passwordSchema } from '../auth/auth.schema';
import { paginationSchema } from '../../utils/pagination';
import { Role } from '../../generated/prisma/enums';

const roleSchema = z.enum([Role.USER, Role.ADMIN]);

/** Admin-only: creating a user directly, with an explicit role. */
export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailSchema,
  password: passwordSchema,
  role: roleSchema.default(Role.USER),
  isActive: z.boolean().default(true),
  /** Optional placement. The department must exist and still be active. */
  departmentId: z.uuid('A valid department id is required').optional(),
});

/**
 * Fields a caller may change on their own profile. `role`, `isActive` and
 * `departmentId` are absent by design — self-promotion to ADMIN must be
 * impossible, and moving yourself between departments is an admin decision.
 */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: emailSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Admin-only superset: may additionally change role and activation. */
export const adminUpdateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: emailSchema.optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
    /** `null` clears the placement, leaving the account without a department. */
    departmentId: z.uuid('A valid department id is required').nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const listUsersSchema = paginationSchema.extend({
  role: roleSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  departmentId: z.uuid('A valid department id is required').optional(),
  /** `?unassigned=true` finds the accounts nobody has placed yet. */
  unassigned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersSchema>;
