import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';

const nameSchema = z.string().trim().min(2, 'Name must be at least 2 characters').max(100);

/**
 * The short handle. Uppercased before validating so `it` and `IT` are the same
 * department — the uniqueness check and the stored value then always agree,
 * the way `emailSchema` handles casing for addresses.
 */
const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .min(2, 'Code must be at least 2 characters')
      .max(16, 'Code must be at most 16 characters')
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Code may contain letters, digits, hyphen and underscore'),
  );

export const createDepartmentSchema = z.object({
  name: nameSchema,
  code: codeSchema,
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().default(true),
});

export const updateDepartmentSchema = z
  .object({
    name: nameSchema.optional(),
    code: codeSchema.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const listDepartmentsSchema = paginationSchema.extend({
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

/** Body of the bulk assignment endpoint: move these users into this department. */
export const assignMembersSchema = z.object({
  userIds: z
    .array(z.uuid('A valid user id is required'))
    .min(1, 'At least one user id is required')
    .max(100, 'At most 100 users can be assigned at once'),
});

/** Route params for `/departments/:id/members/:userId`. */
export const departmentMemberParamSchema = z.object({
  id: z.uuid('A valid department id is required'),
  userId: z.uuid('A valid user id is required'),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsSchema>;
export type AssignMembersInput = z.infer<typeof assignMembersSchema>;
export type DepartmentMemberParam = z.infer<typeof departmentMemberParamSchema>;
