import type { Request, Response } from 'express';
import { params, query } from '../../middlewares/validate';
import type { UuidParam } from '../../utils/pagination';
import type { ListUsersQuery } from '../users/user.schema';
import * as departmentService from './department.service';
import type {
  AssignMembersInput,
  CreateDepartmentInput,
  DepartmentMemberParam,
  ListDepartmentsQuery,
  UpdateDepartmentInput,
} from './department.schema';

export async function list(req: Request, res: Response): Promise<void> {
  const { items, meta } = await departmentService.listDepartments(
    query<ListDepartmentsQuery>(req),
  );
  res.json({ success: true, data: items, meta });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const department = await departmentService.getDepartmentById(params<UuidParam>(req).id);
  res.json({ success: true, data: { department } });
}

export async function create(req: Request, res: Response): Promise<void> {
  const department = await departmentService.createDepartment(req.body as CreateDepartmentInput);
  res.status(201).json({ success: true, message: 'Department created', data: { department } });
}

export async function update(req: Request, res: Response): Promise<void> {
  const department = await departmentService.updateDepartment(
    params<UuidParam>(req).id,
    req.body as UpdateDepartmentInput,
  );
  res.json({ success: true, message: 'Department updated', data: { department } });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await departmentService.deleteDepartment(params<UuidParam>(req).id);
  res.status(204).send();
}

export async function listMembers(req: Request, res: Response): Promise<void> {
  const { items, meta } = await departmentService.listDepartmentMembers(
    params<UuidParam>(req).id,
    query<ListUsersQuery>(req),
  );
  res.json({ success: true, data: items, meta });
}

export async function addMembers(req: Request, res: Response): Promise<void> {
  const result = await departmentService.assignMembers(
    params<UuidParam>(req).id,
    req.body as AssignMembersInput,
  );
  res.json({
    success: true,
    message: `${result.assigned} user(s) assigned to the department`,
    data: result,
  });
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  const { id, userId } = params<DepartmentMemberParam>(req);
  await departmentService.removeMember(id, userId);
  res.status(204).send();
}
