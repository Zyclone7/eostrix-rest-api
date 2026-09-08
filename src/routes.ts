import { Router } from 'express';
import { prisma } from './config/prisma';
import authRoutes from './modules/auth/auth.routes';
import userRoutes from './modules/users/user.routes';
import postRoutes from './modules/posts/post.routes';
import bookRoutes from './modules/books/book.routes';

const router = Router();

/** Liveness + database readiness, for load balancers and uptime checks. */
router.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'up', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down' });
  }
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/posts', postRoutes);
router.use('/books', bookRoutes);

export default router;
