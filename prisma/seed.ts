/**
 * Idempotent seed: creates the first administrator plus a demo user and a
 * couple of posts. Safe to run repeatedly — it upserts.
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

  const admin = await prisma.user.upsert({
    where: { email: env.SEED_ADMIN_EMAIL },
    update: { role: Role.ADMIN, isActive: true },
    create: {
      email: env.SEED_ADMIN_EMAIL,
      name: env.SEED_ADMIN_NAME,
      password: await hashPassword(env.SEED_ADMIN_PASSWORD),
      role: Role.ADMIN,
    },
  });
  console.log(`Admin ready: ${admin.email}`);

  const demoUser = await prisma.user.upsert({
    where: { email: 'user@example.com' },
    update: {},
    create: {
      email: 'user@example.com',
      name: 'Demo User',
      password: await hashPassword('User123!pass'),
      role: Role.USER,
    },
  });
  console.log(`Demo user ready: ${demoUser.email}`);

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
