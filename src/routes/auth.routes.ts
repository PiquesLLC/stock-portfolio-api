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
  testGetVerificationCodeHandler,
} from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { loginLimiter, setPasswordLimiter, signupLimiter, mutationLimiter, apiLimiter, enumerationLimiter } from '../middleware/rateLimiter';
import mfaRoutes from './mfa.routes';

const router = Router();

// Mount MFA sub-routes at /auth/mfa/*
router.use('/mfa', mfaRoutes);

// POST /auth/login - Login with username and password (rate limited)
router.post('/login', loginLimiter, loginHandler);

// POST /auth/logout - Clear auth cookies and revoke refresh tokens
router.post('/logout', mutationLimiter, logoutHandler);

// POST /auth/refresh - Exchange refresh token for new access + refresh tokens
router.post('/refresh', apiLimiter, refreshHandler);

// GET /auth/me - Get current authenticated user
router.get('/me', requireAuth, meHandler);

// POST /auth/set-password - Set password for existing passwordless user (requires auth)
router.post('/set-password', setPasswordLimiter, requireAuth, setPasswordHandler);

// GET /auth/has-password/:username - Check if user has password set (rate limited to prevent enumeration)
router.get('/has-password/:username', enumerationLimiter, hasPasswordHandler);

// POST /auth/signup - Create new user account (rate limited)
router.post('/signup', signupLimiter, signupHandler);

// POST /auth/verify-email - Verify signup email OTP
router.post('/verify-email', apiLimiter, verifyEmailHandler);

// POST /auth/resend-verification - Resend signup email OTP
router.post('/resend-verification', mutationLimiter, resendVerificationHandler);

// GET /auth/test/verification-code - Non-production helper for CI/local smoke tests
router.get('/test/verification-code', apiLimiter, testGetVerificationCodeHandler);

// GET /auth/check-username/:username - Check if username is available (rate limited to prevent enumeration)
router.get('/check-username/:username', enumerationLimiter, checkUsernameHandler);

// POST /auth/change-password - Change password (requires auth)
router.post('/change-password', mutationLimiter, requireAuth, changePasswordHandler);

// DELETE /auth/delete-account - Permanently delete account (requires auth + password)
router.delete('/delete-account', mutationLimiter, requireAuth, deleteAccountHandler);

export default router;
