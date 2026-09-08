import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { Role } from '../generated/prisma/enums';

/**
 * Role gate. Must run after `authenticate`.
 *
 *   router.delete('/:id', authenticate, authorize(Role.ADMIN), handler)
 */
export function authorize(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(ApiError.unauthorized());

    if (!allowedRoles.includes(req.user.role)) {
      return next(ApiError.forbidden('This action requires a higher privilege level'));
    }
    next();
  };
}

export const requireAdmin = authorize(Role.ADMIN);

/** True when the caller is an admin, or is acting on their own record. */
export function isSelfOrAdmin(req: Request, ownerId: string): boolean {
  if (!req.user) return false;
  return req.user.role === Role.ADMIN || req.user.id === ownerId;
}

/**
 * Ownership gate for a resource that has already been loaded.
 * Admins bypass it; everyone else must own the row.
 */
export function assertCanMutate(req: Request, ownerId: string): void {
  if (!isSelfOrAdmin(req, ownerId)) {
    throw ApiError.forbidden('You can only modify your own resources');
  }
}
