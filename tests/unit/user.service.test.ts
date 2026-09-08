jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import * as userService from '../../src/modules/users/user.service';
import { Role } from '../../src/generated/prisma/enums';

const db = prismaMockFrom(prismaModule);

const ADMIN_ID = 'admin-1';
const TARGET_ID = 'user-2';

function publicUser(overrides: Record<string, unknown> = {}) {
  return { id: TARGET_ID, email: 'user@example.com', name: 'User', role: Role.USER, ...overrides };
}

describe('listUsers', () => {
  beforeEach(() => {
    db.user.findMany.mockResolvedValue([]);
    db.user.count.mockResolvedValue(0);
  });

  it('never selects the password column', async () => {
    await userService.listUsers({ page: 1, limit: 20, sortOrder: 'desc' } as never);

    expect(db.user.findMany.mock.calls[0][0].select.password).toBeUndefined();
  });

  it('filters by role and activation when asked', async () => {
    await userService.listUsers({
      page: 1,
      limit: 20,
      sortOrder: 'desc',
      role: Role.ADMIN,
      isActive: true,
    } as never);

    expect(db.user.findMany.mock.calls[0][0].where).toMatchObject({
      role: Role.ADMIN,
      isActive: true,
    });
  });

  it('searches name and email case-insensitively', async () => {
    await userService.listUsers({ page: 1, limit: 20, sortOrder: 'desc', search: 'ali' } as never);

    expect(db.user.findMany.mock.calls[0][0].where.OR).toEqual([
      { name: { contains: 'ali', mode: 'insensitive' } },
      { email: { contains: 'ali', mode: 'insensitive' } },
    ]);
  });

  it('ignores an unlisted sort column', async () => {
    await userService.listUsers({
      page: 1,
      limit: 20,
      sortOrder: 'desc',
      sortBy: 'password',
    } as never);

    expect(db.user.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });
});

describe('getUserById', () => {
  it('404s when absent', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(userService.getUserById(TARGET_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

describe('createUser', () => {
  it('rejects a duplicate email with 409 before writing', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(
      userService.createUser({
        name: 'Bob',
        email: 'bob@example.com',
        password: 'Str0ngPass!23',
        role: Role.USER,
        isActive: true,
      }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('stores a hash, never the plaintext password', async () => {
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockResolvedValue(publicUser());

    await userService.createUser({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Str0ngPass!23',
      role: Role.USER,
      isActive: true,
    });

    const written = db.user.create.mock.calls[0][0].data.password;
    expect(written).not.toBe('Str0ngPass!23');
    expect(written).toMatch(/^\$2[aby]\$/);
  });
});

describe('updateProfile', () => {
  it('rejects an email already owned by someone else', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'someone-else' });

    await expect(
      userService.updateProfile(TARGET_ID, { email: 'taken@example.com' }),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('allows keeping your own email', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID });
    db.user.update.mockResolvedValue(publicUser());

    await expect(
      userService.updateProfile(TARGET_ID, { email: 'mine@example.com' }),
    ).resolves.toBeDefined();
  });
});

describe('adminUpdateUser guard rails', () => {
  it('refuses to let an admin remove their own admin role', async () => {
    db.user.findUnique.mockResolvedValue({ id: ADMIN_ID, role: Role.ADMIN });

    await expect(
      userService.adminUpdateUser(ADMIN_ID, { role: Role.USER }, ADMIN_ID),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses to let an admin deactivate themselves', async () => {
    db.user.findUnique.mockResolvedValue({ id: ADMIN_ID, role: Role.ADMIN });

    await expect(
      userService.adminUpdateUser(ADMIN_ID, { isActive: false }, ADMIN_ID),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('refuses to demote the last remaining admin', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.ADMIN });
    db.user.count.mockResolvedValue(0); // no other active admins

    await expect(
      userService.adminUpdateUser(TARGET_ID, { role: Role.USER }, ADMIN_ID),
    ).rejects.toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('allows demoting an admin while another remains', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.ADMIN });
    db.user.count.mockResolvedValue(1);
    db.user.update.mockResolvedValue(publicUser());

    await expect(
      userService.adminUpdateUser(TARGET_ID, { role: Role.USER }, ADMIN_ID),
    ).resolves.toBeDefined();
  });

  it('404s for an unknown target', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(userService.adminUpdateUser(TARGET_ID, { name: 'X' }, ADMIN_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});

describe('adminUpdateUser session invalidation', () => {
  it('revokes the target sessions after a role change', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.USER });
    db.user.update.mockResolvedValue(publicUser({ role: Role.ADMIN }));

    await userService.adminUpdateUser(TARGET_ID, { role: Role.ADMIN }, ADMIN_ID);

    // A privilege change must take effect now, not when the access token expires.
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: TARGET_ID, revokedAt: null } }),
    );
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tokensValidFrom: expect.any(Date) }) }),
    );
  });

  it('revokes sessions on deactivation', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.USER });
    db.user.update.mockResolvedValue(publicUser({ isActive: false }));

    await userService.adminUpdateUser(TARGET_ID, { isActive: false }, ADMIN_ID);

    expect(db.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('leaves sessions alone for a harmless rename', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.USER });
    db.user.update.mockResolvedValue(publicUser({ name: 'Renamed' }));

    await userService.adminUpdateUser(TARGET_ID, { name: 'Renamed' }, ADMIN_ID);

    expect(db.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});

describe('deleteUser', () => {
  it('refuses self-deletion', async () => {
    await expect(userService.deleteUser(ADMIN_ID, ADMIN_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete the last admin', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.ADMIN });
    db.user.count.mockResolvedValue(0);

    await expect(userService.deleteUser(TARGET_ID, ADMIN_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it('deletes an ordinary user', async () => {
    db.user.findUnique.mockResolvedValue({ id: TARGET_ID, role: Role.USER });
    db.user.delete.mockResolvedValue(publicUser());

    await expect(userService.deleteUser(TARGET_ID, ADMIN_ID)).resolves.toBeUndefined();
    expect(db.user.delete).toHaveBeenCalledWith({ where: { id: TARGET_ID } });
  });

  it('404s for an unknown user', async () => {
    db.user.findUnique.mockResolvedValue(null);

    await expect(userService.deleteUser(TARGET_ID, ADMIN_ID)).rejects.toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });
});
