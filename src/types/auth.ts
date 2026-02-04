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
  user: {
    id: string;
    username: string;
    displayName: string;
  };
}

export interface SetPasswordRequest {
  username: string;
  password: string;
}
