import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { disconnectPrisma, prisma } from './config/prisma';

async function bootstrap(): Promise<void> {
  // Fail fast: a server that cannot reach its database should not accept traffic.
  await prisma.$connect();
  logger.info('Database connection established');

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}/api/v1 [${env.NODE_ENV}]`);
  });

  const shutdown = (signal: string) => async (): Promise<void> => {
    logger.info(`${signal} received, shutting down gracefully`);

    // Stop accepting new connections, let in-flight requests finish, then
    // release the database pool.
    server.close(async (error) => {
      if (error) logger.error({ err: error }, 'Error while closing HTTP server');
      await disconnectPrisma();
      process.exit(error ? 1 : 0);
    });

    // Hard limit so a hung socket cannot block the deploy forever.
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
}

bootstrap().catch(async (error) => {
  logger.fatal({ err: error }, 'Failed to start server');
  await disconnectPrisma().catch(() => undefined);
  process.exit(1);
});
