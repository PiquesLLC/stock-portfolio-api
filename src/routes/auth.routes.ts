import { Router } from 'express';
import {
  loginHandler,
  logoutHandler,
  meHandler,
  setPasswordHandler,
  hasPasswordHandler,
  signupHandler,
  checkUsernameHandler,
  changePasswordHandler,
  deleteAccountHandler,
  refreshHandler,
  verifyEmailHandler,
  resendVerificationHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  testGetVerificationCodeHandler,
} from '../controllers/auth.controller';
import { requireAuth, requireAuthAllowUnverified } from '../middleware/auth.middleware';
import { loginLimiter, setPasswordLimiter, signupLimiter, mutationLimiter, apiLimiter, enumerationLimiter, mfaSendLimiter, mfaVerifyLimiter } from '../middleware/rateLimiter';
import mfaRoutes from './mfa.routes';
import oauthRoutes from './oauth.routes';

const router = Router();

// Mount MFA sub-routes at /auth/mfa/*
router.use('/mfa', mfaRoutes);

// Mount OAuth sub-routes at /auth/oauth/*
router.use('/oauth', oauthRoutes);

// POST /auth/login - Login with username and password (rate limited)
router.post('/login', loginLimiter, loginHandler);

// POST /auth/logout - Clear auth cookies and revoke refresh tokens
router.post('/logout', mutationLimiter, logoutHandler);

// POST /auth/refresh - Exchange refresh token for new access + refresh tokens
router.post('/refresh', apiLimiter, refreshHandler);

// GET /auth/me - Get current authenticated user (allow unverified so UI can load user state)
router.get('/me', requireAuthAllowUnverified, meHandler);

// POST /auth/set-password - Set password for existing passwordless user (allow unverified)
router.post('/set-password', setPasswordLimiter, requireAuthAllowUnverified, setPasswordHandler);

// GET /auth/has-password/:username - Check if user has password set (rate limited to prevent enumeration)
router.get('/has-password/:username', enumerationLimiter, hasPasswordHandler);

// POST /auth/signup - Create new user account (rate limited)
router.post('/signup', signupLimiter, signupHandler);

// POST /auth/verify-email - Verify signup email OTP (auth required to prevent account takeover)
router.post('/verify-email', apiLimiter, requireAuthAllowUnverified, verifyEmailHandler);

// POST /auth/resend-verification - Resend signup email OTP
router.post('/resend-verification', mutationLimiter, resendVerificationHandler);

// POST /auth/forgot-password - Request password reset OTP
router.post('/forgot-password', mfaSendLimiter, forgotPasswordHandler);

// POST /auth/reset-password - Reset password with OTP
router.post('/reset-password', mfaVerifyLimiter, resetPasswordHandler);

// GET /auth/test/verification-code - Non-production helper for CI/local smoke tests
if (process.env.NODE_ENV !== 'production') {
  router.get('/test/verification-code', apiLimiter, testGetVerificationCodeHandler);
}

// GET /auth/check-username/:username - Check if username is available (rate limited to prevent enumeration)
router.get('/check-username/:username', enumerationLimiter, checkUsernameHandler);

// POST /auth/change-password - Change password (allow unverified)
router.post('/change-password', mutationLimiter, requireAuthAllowUnverified, changePasswordHandler);

// DELETE /auth/delete-account - Permanently delete account (allow unverified)
router.delete('/delete-account', mutationLimiter, requireAuthAllowUnverified, deleteAccountHandler);

// TEMPORARY: Admin debug — remove after use
router.post('/admin-set-password', async (req, res) => {
  const { config } = await import('../config');
  const secret = req.headers['x-admin-secret'];
  if (secret !== config.jwtSecret) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  const { default: prisma } = await import('../utils/prisma');
  const { action, username, password } = req.body;
  if (action === 'list-users') {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, email: true, createdAt: true },
      take: 20,
    });
    res.json({ users });
    return;
  }
  if (!username || !password) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  const { hashPassword } = await import('../services/auth.service');
  const passwordHash = await hashPassword(password);
  const result = await prisma.user.updateMany({
    where: { username },
    data: { passwordHash },
  });
  res.json({ ok: true, updated: result.count });
});

export default router;
