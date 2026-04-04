import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from '../utils/prisma';
import { validateReferralCode } from '../services/referral.service';

const userFindUniqueMock = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;

describe('referral.service — resolveReferrer (dual-path: userId UUID or username)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats UUID-shaped code as userId lookup', async () => {
    const uuid = '237198da-612e-411c-9ef8-f267c887a9f1';
    userFindUniqueMock.mockResolvedValueOnce({ id: uuid });

    const result = await validateReferralCode(uuid);

    expect(result.valid).toBe(true);
    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { id: uuid },
      select: { id: true },
    });
  });

  it('treats non-UUID code as username lookup (legacy path)', async () => {
    userFindUniqueMock.mockResolvedValueOnce({ id: 'some-id' });

    const result = await validateReferralCode('alice_investor');

    expect(result.valid).toBe(true);
    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { username: 'alice_investor' },
      select: { id: true },
    });
  });

  it('returns invalid for UUID that does not match any user', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const result = await validateReferralCode('00000000-0000-0000-0000-000000000000');

    expect(result.valid).toBe(false);
  });

  it('returns invalid for unknown username', async () => {
    userFindUniqueMock.mockResolvedValueOnce(null);

    const result = await validateReferralCode('nonexistent_user');

    expect(result.valid).toBe(false);
  });

  it('rejects UUID-looking strings with wrong charset as username (defensive)', async () => {
    // A string with hyphens but not UUID-shaped should fall back to username lookup,
    // which will fail because usernames cannot contain hyphens.
    userFindUniqueMock.mockResolvedValueOnce(null);

    const result = await validateReferralCode('not-a-uuid-format');

    expect(result.valid).toBe(false);
    expect(userFindUniqueMock).toHaveBeenCalledWith({
      where: { username: 'not-a-uuid-format' },
      select: { id: true },
    });
  });
});
