import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { mfaVerifyLimiter, mfaSendLimiter, mutationLimiter } from '../middleware/rateLimiter';
import {
  verifyMfaHandler, sendEmailOtpHandler, mfaStatusHandler,
  totpSetupHandler, totpVerifySetupHandler, totpDisableHandler,
  updateEmailHandler, verifyEmailHandler,
  emailOtpSetupHandler, emailOtpVerifySetupHandler, emailOtpDisableHandler,
  regenerateBackupCodesHandler,
} from '../controllers/mfa.controller';

const router = Router();

// ─── Login MFA (no auth required, uses challenge token) ───
router.post('/verify', mfaVerifyLimiter, verifyMfaHandler);
router.post('/email/send', mfaSendLimiter, sendEmailOtpHandler);

// ─── MFA Status ───
router.get('/status', requireAuth, mfaStatusHandler);

// ─── TOTP Setup ───
router.post('/totp/setup', mutationLimiter, requireAuth, totpSetupHandler);
router.post('/totp/verify-setup', mfaVerifyLimiter, requireAuth, totpVerifySetupHandler);
router.post('/totp/disable', mutationLimiter, requireAuth, totpDisableHandler);

// ─── Email Management ───
router.put('/email', mutationLimiter, requireAuth, updateEmailHandler);
router.post('/email/verify', mfaVerifyLimiter, requireAuth, verifyEmailHandler);

// ─── Email OTP Setup ───
router.post('/email-otp/setup', mutationLimiter, requireAuth, emailOtpSetupHandler);
router.post('/email-otp/verify-setup', mfaVerifyLimiter, requireAuth, emailOtpVerifySetupHandler);
router.post('/email-otp/disable', mutationLimiter, requireAuth, emailOtpDisableHandler);

// ─── Backup Codes ───
router.post('/backup-codes/regenerate', mutationLimiter, requireAuth, regenerateBackupCodesHandler);

export default router;
