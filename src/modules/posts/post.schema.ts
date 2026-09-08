import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';

export const createPostSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(200),
  content: z.string().trim().min(1, 'Content is required').max(20_000),
  published: z.boolean().default(false),
  // NOTE: no `authorId`. Ownership is taken from the authenticated session,
  // so a caller cannot create a post on someone else's behalf.
});

export const updatePostSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    content: z.string().trim().min(1).max(20_000).optional(),
    published: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const listPostsSchema = paginationSchema.extend({
  published: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  authorId: z.uuid().optional(),
  mine: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type ListPostsQuery = z.infer<typeof listPostsSchema>;
