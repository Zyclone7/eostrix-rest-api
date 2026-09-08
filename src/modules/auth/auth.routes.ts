import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { validate } from '../../middlewares/validate';
import { authLimiter, registerLimiter } from '../../middlewares/rateLimiter';
import * as controller from './auth.controller';
import { changePasswordSchema, loginSchema, refreshSchema, registerSchema } from './auth.schema';

const router = Router();

router.post('/register', registerLimiter, validate({ body: registerSchema }), controller.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', controller.logout);

router.get('/me', authenticate, controller.me);
router.post('/logout-all', authenticate, controller.logoutAll);
router.patch(
  '/change-password',
  authenticate,
  authLimiter,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);

export default router;
