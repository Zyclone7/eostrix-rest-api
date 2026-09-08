import { z } from 'zod';

/** Shared query shape for every list endpoint. The upper bound on `limit` is
 *  a denial-of-service control: a client cannot ask for 10 million rows. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(100).optional(),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export function buildMeta(total: number, page: number, limit: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function skipTake(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}

/**
 * Whitelists the sort column. Interpolating a client-supplied string into an
 * `orderBy` lets a caller order by — and therefore probe — arbitrary columns.
 */
export function resolveSort<T extends string>(
  sortBy: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(sortBy as T) ? (sortBy as T) : fallback;
}

export const uuidParamSchema = z.object({
  id: z.uuid('A valid resource id is required'),
});

export type UuidParam = z.infer<typeof uuidParamSchema>;
