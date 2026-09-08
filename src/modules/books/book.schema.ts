import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination';

/**
 * Multipart fields arrive as strings, so `published` is parsed from the two
 * literals a form can actually send rather than with `z.boolean()`.
 */
const booleanField = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const createBookSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300),
  author: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5_000).optional(),
  // BCP-47-ish; kept loose because it is a label, not a lookup key.
  language: z.string().trim().min(2).max(35).optional(),
  published: booleanField.default(false),
  // NOTE: no file metadata here. Size, checksum, media type and storage key
  // are all derived server-side from the bytes, never taken from the client.
});

export const updateBookSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    author: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5_000).optional(),
    language: z.string().trim().min(2).max(35).optional(),
    published: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const listBooksSchema = paginationSchema.extend({
  published: booleanField.optional(),
  uploadedById: z.uuid().optional(),
});

/** `?download=true` switches the file response from inline to an attachment. */
export const downloadQuerySchema = z.object({
  download: booleanField.optional(),
});

export type CreateBookInput = z.infer<typeof createBookSchema>;
export type UpdateBookInput = z.infer<typeof updateBookSchema>;
export type ListBooksQuery = z.infer<typeof listBooksSchema>;
export type DownloadQuery = z.infer<typeof downloadQuerySchema>;
