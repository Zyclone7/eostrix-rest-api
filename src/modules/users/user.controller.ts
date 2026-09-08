import type { Request, Response } from 'express';
import { params, query } from '../../middlewares/validate';
import type { UuidParam } from '../../utils/pagination';
import * as userService from './user.service';
import type {
  AdminUpdateUserInput,
  CreateUserInput,
  ListUsersQuery,
  UpdateProfileInput,
} from './user.schema';

export async function list(req: Request, res: Response): Promise<void> {
  const { items, meta } = await userService.listUsers(query<ListUsersQuery>(req));
  res.json({ success: true, data: items, meta });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const user = await userService.getUserById(params<UuidParam>(req).id);
  res.json({ success: true, data: { user } });
}

export async function create(req: Request, res: Response): Promise<void> {
  const user = await userService.createUser(req.body as CreateUserInput);
  res.status(201).json({ success: true, message: 'User created', data: { user } });
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const user = await userService.updateProfile(req.user!.id, req.body as UpdateProfileInput);
  res.json({ success: true, message: 'Profile updated', data: { user } });
}

export async function update(req: Request, res: Response): Promise<void> {
  const user = await userService.adminUpdateUser(
    params<UuidParam>(req).id,
    req.body as AdminUpdateUserInput,
    req.user!.id,
  );
  res.json({ success: true, message: 'User updated', data: { user } });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await userService.deleteUser(params<UuidParam>(req).id, req.user!.id);
  res.status(204).send();
}
