import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireEmailVerifiedForAi } from '../middleware/email-verification.middleware';
import { EmailVerificationRequiredError } from '../services/email-verification-guard.service';
import * as guardService from '../services/email-verification-guard.service';

describe('requireEmailVerifiedForAi middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMocks() {
    const req: any = { user: undefined };
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
    return { req, res, next };
  }

  it('returns 401 when user is missing', async () => {
    const { req, res, next } = createMocks();

    await requireEmailVerifiedForAi(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when guard passes', async () => {
    const { req, res, next } = createMocks();
    req.user = { userId: 'user-1' };
    vi.spyOn(guardService, 'ensureEmailVerifiedForAi').mockResolvedValue(undefined);

    await requireEmailVerifiedForAi(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 for EmailVerificationRequiredError', async () => {
    const { req, res, next } = createMocks();
    req.user = { userId: 'user-2' };
    vi.spyOn(guardService, 'ensureEmailVerifiedForAi').mockRejectedValue(new EmailVerificationRequiredError());

    await requireEmailVerifiedForAi(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'email_verification_required' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 for unexpected guard errors', async () => {
    const { req, res, next } = createMocks();
    req.user = { userId: 'user-3' };
    vi.spyOn(guardService, 'ensureEmailVerifiedForAi').mockRejectedValue(new Error('db down'));

    await requireEmailVerifiedForAi(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows SYSTEM_USER_ID bypass path when guard service resolves', async () => {
    const { req, res, next } = createMocks();
    req.user = { userId: '237198da-612e-411c-9ef8-f267c887a9f1' };
    vi.spyOn(guardService, 'ensureEmailVerifiedForAi').mockResolvedValue(undefined);

    await requireEmailVerifiedForAi(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
