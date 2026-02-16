import { Request } from 'express';

export interface JwtPayload {
  userId: string;
  username: string;
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

export type AuthErrorCode = 'NO_TOKEN' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'TOKEN_REVOKED';

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
