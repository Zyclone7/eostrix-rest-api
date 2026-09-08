import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { writeLimiter } from '../../middlewares/rateLimiter';
import { uuidParamSchema } from '../../utils/pagination';
import * as controller from './user.controller';
import {
  adminUpdateUserSchema,
  createUserSchema,
  listUsersSchema,
  updateProfileSchema,
} from './user.schema';

const router = Router();

// Every route below requires a valid session.
router.use(authenticate);

// --- Self-service -----------------------------------------------------------
router.patch('/me', writeLimiter, validate({ body: updateProfileSchema }), controller.updateMe);

// --- Admin only -------------------------------------------------------------
// The gate is applied once here rather than repeated per route, so a new admin
// route added below cannot accidentally ship without authorisation.
router.use(requireAdmin);

router.get('/', validate({ query: listUsersSchema }), controller.list);
router.post('/', writeLimiter, validate({ body: createUserSchema }), controller.create);
router.get('/:id', validate({ params: uuidParamSchema }), controller.getOne);
router.patch(
  '/:id',
  writeLimiter,
  validate({ params: uuidParamSchema, body: adminUpdateUserSchema }),
  controller.update,
);
router.delete('/:id', writeLimiter, validate({ params: uuidParamSchema }), controller.remove);

export default router;
