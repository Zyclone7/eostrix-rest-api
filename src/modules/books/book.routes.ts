import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { writeLimiter } from '../../middlewares/rateLimiter';
import { uploadEpub } from '../../middlewares/upload';
import { uuidParamSchema } from '../../utils/pagination';
import * as controller from './book.controller';
import {
  createBookSchema,
  downloadQuerySchema,
  listBooksSchema,
  updateBookSchema,
} from './book.schema';

const router = Router();

// The whole library is behind a session: unlike posts, nothing here is public.
router.use(authenticate);

// --- Reader surface (any signed-in user) ------------------------------------
router.get('/', validate({ query: listBooksSchema }), controller.list);
router.get('/:id', validate({ params: uuidParamSchema }), controller.getOne);
router.get(
  '/:id/file',
  validate({ params: uuidParamSchema, query: downloadQuerySchema }),
  controller.download,
);

// --- Librarian surface (ADMIN only) -----------------------------------------
// Order matters: the role gate runs before multer, so a non-admin's upload is
// rejected on the headers rather than after megabytes have been buffered.
router.post(
  '/',
  requireAdmin,
  writeLimiter,
  uploadEpub('file'),
  validate({ body: createBookSchema }),
  controller.create,
);
router.patch(
  '/:id',
  requireAdmin,
  writeLimiter,
  validate({ params: uuidParamSchema, body: updateBookSchema }),
  controller.update,
);
router.delete(
  '/:id',
  requireAdmin,
  writeLimiter,
  validate({ params: uuidParamSchema }),
  controller.remove,
);

export default router;
