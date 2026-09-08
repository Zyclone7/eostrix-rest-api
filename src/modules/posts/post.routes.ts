import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { writeLimiter } from '../../middlewares/rateLimiter';
import { uuidParamSchema } from '../../utils/pagination';
import * as controller from './post.controller';
import { createPostSchema, listPostsSchema, updatePostSchema } from './post.schema';

const router = Router();

// Reads are public, but a recognised caller also sees their own drafts —
// hence optional authentication rather than none.
router.get('/', optionalAuthenticate, validate({ query: listPostsSchema }), controller.list);
router.get('/:id', optionalAuthenticate, validate({ params: uuidParamSchema }), controller.getOne);

// Writes always require a session; ownership is enforced in the service layer,
// which is what lets an ADMIN edit any post while a USER edits only their own.
router.post(
  '/',
  authenticate,
  writeLimiter,
  validate({ body: createPostSchema }),
  controller.create,
);
router.patch(
  '/:id',
  authenticate,
  writeLimiter,
  validate({ params: uuidParamSchema, body: updatePostSchema }),
  controller.update,
);
router.delete(
  '/:id',
  authenticate,
  writeLimiter,
  validate({ params: uuidParamSchema }),
  controller.remove,
);

export default router;
