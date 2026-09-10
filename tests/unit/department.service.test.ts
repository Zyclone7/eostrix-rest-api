jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import * as departmentService from '../../src/modules/departments/department.service';

const db = prismaMockFrom(prismaModule);

const DEPT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function department(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPT_ID,
    name: 'Information Technology',
    code: 'IT',
    isActive: true,
    _count: { users: 0 },
    ...overrides,
  };
}

const LIST_QUERY = { page: 1, limit: 20, sortOrder: 'desc' as const };

describe('listDepartments', () => {
  beforeEach(() => {
    db.department.findMany.mockResolvedValue([]);
    db.department.count.mockResolvedValue(0);
  });

  it('returns the member count alongside each row', async () => {
    await departmentService.listDepartments(LIST_QUERY as never);

    expect(db.department.findMany.mock.calls[0][0].select._count).toEqual({
      select: { users: true },
    });
  });

  it('filters by activation when asked', async () => {
    await departmentService.listDepartments({ ...LIST_QUERY, isActive: false } as never);

    expect(db.department.findMany.mock.calls[0][0].where).toMatchObject({ isActive: false });
  });

  it('searches name, code and description case-insensitively', async () => {
    await departmentService.listDepartments({ ...LIST_QUERY, search: 'acc' } as never);

    expect(db.department.findMany.mock.calls[0][0].where.OR).toEqual([
      { name: { contains: 'acc', mode: 'insensitive' } },
      { code: { contains: 'acc', mode: 'insensitive' } },
      { description: { contains: 'acc', mode: 'insensitive' } },
    ]);
  });

  it('ignores an unlisted sort column and orders by name', async () => {
    await departmentService.listDepartments({ ...LIST_QUERY, sortBy: 'id' } as never);

    expect(db.department.findMany.mock.calls[0][0].orderBy).toEqual({ name: 'desc' });
  });
});

describe('createDepartment', () => {
  it('rejects a duplicate name with 409 before writing', async () => {
    db.department.findMany.mockResolvedValue([{ name: 'Information Technology', code: 'ITX' }]);

    await expect(
      departmentService.createDepartment({
        name: 'Information Technology',
        code: 'IT',
        isActive: true,
      }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(db.department.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate code with 409', async () => {
    db.department.findMany.mockResolvedValue([{ name: 'Other', code: 'IT' }]);

    await expect(
      departmentService.createDepartment({ name: 'Other name', code: 'IT', isActive: true }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('creates when both are free', async () => {
    db.department.findMany.mockResolvedValue([]);
    db.department.create.mockResolvedValue(department());

    await expect(
      departmentService.createDepartment({ name: 'Accounting', code: 'ACC', isActive: true }),
    ).resolves.toBeDefined();
  });
});

describe('updateDepartment', () => {
  it('404s for an unknown department', async () => {
    db.department.findUnique.mockResolvedValue(null);

    await expect(departmentService.updateDepartment(DEPT_ID, { name: 'X Y' })).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it('lets a department keep its own code', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID });
    db.department.findMany.mockResolvedValue([]); // the row itself is excluded
    db.department.update.mockResolvedValue(department());

    await expect(departmentService.updateDepartment(DEPT_ID, { code: 'IT' })).resolves.toBeDefined();
    expect(db.department.findMany.mock.calls[0][0].where.id).toEqual({ not: DEPT_ID });
  });
});

describe('deleteDepartment', () => {
  it('refuses to delete one that still has members', async () => {
    db.department.findUnique.mockResolvedValue(department({ _count: { users: 3 } }));

    await expect(departmentService.deleteDepartment(DEPT_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(db.department.delete).not.toHaveBeenCalled();
  });

  it('deletes an empty department', async () => {
    db.department.findUnique.mockResolvedValue(department());
    db.department.delete.mockResolvedValue(department());

    await expect(departmentService.deleteDepartment(DEPT_ID)).resolves.toBeUndefined();
    expect(db.department.delete).toHaveBeenCalledWith({ where: { id: DEPT_ID } });
  });

  it('404s for an unknown department', async () => {
    db.department.findUnique.mockResolvedValue(null);

    await expect(departmentService.deleteDepartment(DEPT_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

describe('listDepartmentMembers', () => {
  it('scopes the query to the department and hides the password column', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID });
    db.user.findMany.mockResolvedValue([]);
    db.user.count.mockResolvedValue(0);

    await departmentService.listDepartmentMembers(DEPT_ID, LIST_QUERY as never);

    const call = db.user.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ departmentId: DEPT_ID });
    expect(call.select.password).toBeUndefined();
  });

  it('404s for an unknown department', async () => {
    db.department.findUnique.mockResolvedValue(null);

    await expect(
      departmentService.listDepartmentMembers(DEPT_ID, LIST_QUERY as never),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});

describe('assignMembers', () => {
  it('refuses an inactive department', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID, isActive: false });

    await expect(
      departmentService.assignMembers(DEPT_ID, { userIds: [USER_ID] }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('assigns nobody when one id is unknown', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID, isActive: true });
    db.user.findMany.mockResolvedValue([{ id: USER_ID }]);

    await expect(
      departmentService.assignMembers(DEPT_ID, { userIds: [USER_ID, 'missing-id'] }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('moves every listed user in one write', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID, isActive: true });
    db.user.findMany.mockResolvedValue([{ id: USER_ID }]);
    db.user.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      departmentService.assignMembers(DEPT_ID, { userIds: [USER_ID, USER_ID] }),
    ).resolves.toEqual({ assigned: 1 });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [USER_ID] } },
      data: { departmentId: DEPT_ID },
    });
  });
});

describe('removeMember', () => {
  it('rejects a user who belongs to a different department', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID });
    db.user.findUnique.mockResolvedValue({ id: USER_ID, departmentId: 'another-department' });

    await expect(departmentService.removeMember(DEPT_ID, USER_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('clears the placement of a real member', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID });
    db.user.findUnique.mockResolvedValue({ id: USER_ID, departmentId: DEPT_ID });
    db.user.update.mockResolvedValue({ id: USER_ID });

    await departmentService.removeMember(DEPT_ID, USER_ID);

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { departmentId: null },
    });
  });
});

describe('assertAssignable', () => {
  it('rejects an unknown department with 400', async () => {
    db.department.findUnique.mockResolvedValue(null);

    await expect(departmentService.assertAssignable(DEPT_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('rejects a retired department', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID, isActive: false });

    await expect(departmentService.assertAssignable(DEPT_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('accepts an open one', async () => {
    db.department.findUnique.mockResolvedValue({ id: DEPT_ID, isActive: true });

    await expect(departmentService.assertAssignable(DEPT_ID)).resolves.toBeUndefined();
  });
});
