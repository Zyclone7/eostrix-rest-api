/**
 * Idempotent seed: creates the departments, the first administrator, a few
 * demo users placed across those departments, and a couple of posts.
 * Safe to run repeatedly — it upserts.
 *
 *   npm run db:seed
 */
import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';
import { hashPassword } from '../src/utils/password';
import { Role } from '../src/generated/prisma/enums';

async function main(): Promise<void> {
  if (env.isProduction && env.SEED_ADMIN_PASSWORD === 'Admin123!pass') {
    throw new Error('Refusing to seed production with the default admin password.');
  }

  const DEPARTMENTS = [
    {
      code: 'IT',
      name: 'Information Technology',
      description: 'Systems, infrastructure and support.',
    },
    { code: 'ACC', name: 'Accounting', description: 'Bookkeeping, payables and receivables.' },
    { code: 'ECO', name: 'Economics', description: 'Forecasting, pricing and market analysis.' },
  ];

  const departments: Record<string, string> = {};
  for (const department of DEPARTMENTS) {
    const row = await prisma.department.upsert({
      where: { code: department.code },
      update: { name: department.name, description: department.description, isActive: true },
      create: department,
    });
    departments[row.code] = row.id;
  }
  console.log(`Departments ready: ${DEPARTMENTS.map((d) => d.code).join(', ')}`);

  const admin = await prisma.user.upsert({
    where: { email: env.SEED_ADMIN_EMAIL },
    update: { role: Role.ADMIN, isActive: true, departmentId: departments.IT },
    create: {
      email: env.SEED_ADMIN_EMAIL,
      name: env.SEED_ADMIN_NAME,
      password: await hashPassword(env.SEED_ADMIN_PASSWORD),
      role: Role.ADMIN,
      departmentId: departments.IT,
    },
  });
  console.log(`Admin ready: ${admin.email} (IT)`);

  // One demo account per department, so every list-and-filter endpoint has
  // something to return straight after a fresh seed.
  const DEMO_USERS = [
    { email: 'user@example.com', name: 'Demo User', code: 'IT' },
    { email: 'accounting@example.com', name: 'Ada Ledger', code: 'ACC' },
    { email: 'economics@example.com', name: 'Eli Marks', code: 'ECO' },
  ];

  const demoPassword = await hashPassword('User123!pass');
  let demoUser = null as Awaited<ReturnType<typeof prisma.user.upsert>> | null;

  for (const person of DEMO_USERS) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      update: { departmentId: departments[person.code] },
      create: {
        email: person.email,
        name: person.name,
        password: demoPassword,
        role: Role.USER,
        departmentId: departments[person.code],
      },
    });
    demoUser ??= user;
    console.log(`Demo user ready: ${user.email} (${person.code})`);
  }

  if (!demoUser) return;

  const existingPosts = await prisma.post.count({ where: { authorId: demoUser.id } });
  if (existingPosts === 0) {
    await prisma.post.createMany({
      data: [
        {
          title: 'Hello world',
          content: 'A published post, visible to everyone.',
          published: true,
          authorId: demoUser.id,
        },
        {
          title: 'Work in progress',
          content: 'An unpublished draft, visible only to its author and admins.',
          published: false,
          authorId: demoUser.id,
        },
      ],
    });
    console.log('Seeded 2 demo posts');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('Seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
