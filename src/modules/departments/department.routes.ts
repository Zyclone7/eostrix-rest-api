import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { requireAdmin } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { writeLimiter } from '../../middlewares/rateLimiter';
import { uuidParamSchema } from '../../utils/pagination';
import { listUsersSchema } from '../users/user.schema';
import * as controller from './department.controller';
import {
  assignMembersSchema,
  createDepartmentSchema,
  departmentMemberParamSchema,
  listDepartmentsSchema,
  updateDepartmentSchema,
} from './department.schema';

const router = Router();

// The directory itself is readable by any signed-in user — knowing that an
// "IT" department exists is how a client renders a picker. Everything that
// exposes or changes membership is gated below.
router.use(authenticate);

router.get('/', validate({ query: listDepartmentsSchema }), controller.list);
router.get('/:id', validate({ params: uuidParamSchema }), controller.getOne);

// --- Admin only -------------------------------------------------------------
// Applied once, so a route added below cannot ship without authorisation.
router.use(requireAdmin);

// The roster lists user emails, so it carries the same gate as GET /users.
router.get(
  '/:id/members',
  validate({ params: uuidParamSchema, query: listUsersSchema }),
  controller.listMembers,
);
router.post(
  '/:id/members',
  writeLimiter,
  validate({ params: uuidParamSchema, body: assignMembersSchema }),
  controller.addMembers,
);
router.delete(
  '/:id/members/:userId',
  writeLimiter,
  validate({ params: departmentMemberParamSchema }),
  controller.removeMember,
);

router.post('/', writeLimiter, validate({ body: createDepartmentSchema }), controller.create);
router.patch(
  '/:id',
  writeLimiter,
  validate({ params: uuidParamSchema, body: updateDepartmentSchema }),
  controller.update,
);
router.delete('/:id', writeLimiter, validate({ params: uuidParamSchema }), controller.remove);

export default router;
