/**
 * A hand-rolled stand-in for the Prisma client.
 *
 * It is built inside a factory so that a test file can write
 *
 *   jest.mock('../../src/config/prisma', () =>
 *     require('../helpers/prismaMock').buildPrismaModuleMock());
 *
 * without tripping Jest's rule against referencing out-of-scope variables from
 * a hoisted `jest.mock` factory.
 */

type Mock = jest.Mock;

export interface ModelMock {
  findUnique: Mock;
  findFirst: Mock;
  findMany: Mock;
  create: Mock;
  createMany: Mock;
  update: Mock;
  updateMany: Mock;
  upsert: Mock;
  delete: Mock;
  deleteMany: Mock;
  count: Mock;
}

export interface PrismaMock {
  user: ModelMock;
  post: ModelMock;
  refreshToken: ModelMock;
  $transaction: Mock;
  $queryRaw: Mock;
  $connect: Mock;
  $disconnect: Mock;
}

function model(): ModelMock {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
  };
}

export function buildPrismaModuleMock() {
  const prisma: PrismaMock = {
    user: model(),
    post: model(),
    refreshToken: model(),
    // The services pass an array of promises; resolving them mirrors the real
    // client closely enough for assertions about what was queried.
    $transaction: jest.fn((operations: unknown) =>
      Array.isArray(operations) ? Promise.all(operations) : Promise.resolve(undefined),
    ),
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };

  return { prisma, disconnectPrisma: jest.fn().mockResolvedValue(undefined) };
}

/** Retrieves the mock from the mocked module with a useful type. */
export function prismaMockFrom(module: { prisma: unknown }): PrismaMock {
  return module.prisma as PrismaMock;
}
