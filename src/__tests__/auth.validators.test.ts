import { describe, it, expect } from 'vitest';
import { loginSchema, signupSchema, setPasswordSchema, changePasswordSchema, deleteAccountSchema, formatZodError } from '../validators/auth.validators';

describe('Auth Validators', () => {
  describe('loginSchema', () => {
    it('accepts valid login', () => {
      expect(loginSchema.safeParse({ username: 'testuser', password: 'pass123' }).success).toBe(true);
    });

    it('rejects missing username', () => {
      expect(loginSchema.safeParse({ password: 'pass123' }).success).toBe(false);
    });

    it('rejects empty username', () => {
      expect(loginSchema.safeParse({ username: '', password: 'pass123' }).success).toBe(false);
    });

    it('rejects missing password', () => {
      expect(loginSchema.safeParse({ username: 'testuser' }).success).toBe(false);
    });
  });

  describe('signupSchema', () => {
    const valid = { username: 'testuser', displayName: 'Test', password: 'TestPass1' };

    it('accepts valid signup', () => {
      expect(signupSchema.safeParse(valid).success).toBe(true);
    });

    it('rejects short username', () => {
      expect(signupSchema.safeParse({ ...valid, username: 'ab' }).success).toBe(false);
    });

    it('rejects long username', () => {
      expect(signupSchema.safeParse({ ...valid, username: 'a'.repeat(21) }).success).toBe(false);
    });

    it('rejects username with special chars', () => {
      expect(signupSchema.safeParse({ ...valid, username: 'test@user' }).success).toBe(false);
    });

    it('rejects weak password (no uppercase)', () => {
      expect(signupSchema.safeParse({ ...valid, password: 'testpass1' }).success).toBe(false);
    });

    it('rejects weak password (no number)', () => {
      expect(signupSchema.safeParse({ ...valid, password: 'TestPasss' }).success).toBe(false);
    });

    it('rejects short password', () => {
      expect(signupSchema.safeParse({ ...valid, password: 'Test1' }).success).toBe(false);
    });

    it('rejects empty display name', () => {
      expect(signupSchema.safeParse({ ...valid, displayName: '' }).success).toBe(false);
    });

    it('rejects too-long display name', () => {
      expect(signupSchema.safeParse({ ...valid, displayName: 'x'.repeat(51) }).success).toBe(false);
    });
  });

  describe('setPasswordSchema', () => {
    it('accepts valid set-password', () => {
      expect(setPasswordSchema.safeParse({ username: 'user', password: 'TestPass1' }).success).toBe(true);
    });

    it('rejects weak password', () => {
      expect(setPasswordSchema.safeParse({ username: 'user', password: 'weak' }).success).toBe(false);
    });
  });

  describe('changePasswordSchema', () => {
    it('accepts valid change', () => {
      expect(changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'NewPass1' }).success).toBe(true);
    });

    it('rejects weak new password', () => {
      expect(changePasswordSchema.safeParse({ currentPassword: 'old', newPassword: 'weak' }).success).toBe(false);
    });
  });

  describe('deleteAccountSchema', () => {
    it('accepts valid', () => {
      expect(deleteAccountSchema.safeParse({ password: 'anypass' }).success).toBe(true);
    });

    it('rejects empty password', () => {
      expect(deleteAccountSchema.safeParse({ password: '' }).success).toBe(false);
    });
  });

  describe('formatZodError', () => {
    it('returns first issue message', () => {
      const result = loginSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        const msg = formatZodError(result.error);
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);
      }
    });
  });
});
