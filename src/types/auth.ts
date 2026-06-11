import { Request } from 'express';

export interface JwtPayload {
  userId: string;
  username: string;
  plan?: string;
  planExpiresAt?: string | null;
  emailVerified?: boolean;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    email?: string | null;
    emailVerified?: boolean;
    plan?: string;
    planExpiresAt?: Date | null;
  };
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  methods: string[];
  maskedEmail: string | null;
}

export interface SetPasswordRequest {
  username: string;
  password: string;
}

// Purpose tags for EmailOtpCode rows. Every issuer stamps one and every
// consumer filters on it, so a code minted for one flow can never satisfy
// another (e.g. an email-verification code must not pass a password reset).
// Pre-migration rows carry the schema default 'legacy', which no consumer
// accepts. EMAIL_CHANGE is reserved for completeness: primary-email-change
// confirmation codes live in their own table (PendingEmailChange) and are
// purpose-isolated by construction.
export const OTP_PURPOSE = {
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
  MFA_SETUP: 'mfa_setup',
  MFA_EMAIL: 'mfa_email',
  EMAIL_CHANGE: 'email_change',
} as const;

export type OtpPurpose = (typeof OTP_PURPOSE)[keyof typeof OTP_PURPOSE];

export type AuthErrorCode = 'NO_TOKEN' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'TOKEN_REVOKED' | 'EMAIL_NOT_VERIFIED';

/**
 * Auth-specific error for authentication failures (401)
 */
export class AuthError extends Error {
  code: AuthErrorCode;
  constructor(message: string, code: AuthErrorCode = 'TOKEN_INVALID') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * Validation error for invalid input (400)
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
