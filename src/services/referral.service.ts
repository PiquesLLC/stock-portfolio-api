import prisma from '../utils/prisma';

// UUID v4 format — userIds in the User table. Usernames cannot contain hyphens
// (regex is [a-zA-Z0-9_]+), so the two formats are disjoint and safe to discriminate.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a referral code (userId UUID or username) to a stable userId.
 * UUID path is preferred — links survive username changes.
 * Username path is kept for backwards compat with old referral links.
 */
async function resolveReferrer(referralCode: string): Promise<{ id: string } | null> {
  if (UUID_PATTERN.test(referralCode)) {
    return prisma.user.findUnique({ where: { id: referralCode }, select: { id: true } });
  }
  return prisma.user.findUnique({ where: { username: referralCode }, select: { id: true } });
}

/**
 * Process a referral during signup.
 * Referral code may be a userId (UUID, preferred) or a username (legacy).
 * Sets referredBy on the new user and creates a Referral record.
 */
export async function processReferral(
  referredUserId: string,
  referralCode: string
): Promise<{ referrerId: string } | null> {
  const referrer = await resolveReferrer(referralCode);

  if (!referrer || referrer.id === referredUserId) return null;

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: referredUserId },
        data: { referredBy: referrer.id },
        select: { id: true },
      }),
      prisma.referral.create({
        data: {
          referrerUserId: referrer.id,
          referredUserId,
          referralCode,
          status: 'signed_up',
        },
      }),
    ]);
    return { referrerId: referrer.id };
  } catch {
    // Unique constraint violation = already referred, silently ignore
    return null;
  }
}

/**
 * Update referral status when a user verifies their email.
 */
export async function markReferralVerified(userId: string): Promise<void> {
  await prisma.referral.updateMany({
    where: { referredUserId: userId, status: 'signed_up' },
    data: { status: 'verified' },
  });
}

/**
 * Update referral status when a user becomes "active" (e.g., adds first holding).
 */
export async function markReferralActive(userId: string): Promise<void> {
  await prisma.referral.updateMany({
    where: { referredUserId: userId, status: 'verified' },
    data: { status: 'active' },
  });
}

/**
 * Get referral stats for a creator/user dashboard.
 */
export async function getReferralStats(userId: string) {
  const [totalReferrals, verifiedReferrals, activeReferrals, recentReferrals] = await Promise.all([
    prisma.referral.count({ where: { referrerUserId: userId } }),
    prisma.referral.count({ where: { referrerUserId: userId, status: 'verified' } }),
    prisma.referral.count({ where: { referrerUserId: userId, status: 'active' } }),
    prisma.referral.findMany({
      where: { referrerUserId: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        referralCode: true,
        status: true,
        createdAt: true,
        referred: {
          select: {
            username: true,
            displayName: true,
          },
        },
      },
    }),
  ]);

  const conversionRate = totalReferrals > 0
    ? Math.round((activeReferrals / totalReferrals) * 100)
    : 0;

  return {
    totalReferrals,
    verifiedReferrals,
    activeReferrals,
    conversionRate,
    recentReferrals: recentReferrals.map(r => ({
      id: r.id,
      username: r.referred.username,
      displayName: r.referred.displayName,
      status: r.status,
      joinedAt: r.createdAt,
    })),
  };
}

/**
 * Validate a referral code (check if user exists).
 * Accepts userId (UUID, preferred) or username (legacy).
 */
export async function validateReferralCode(code: string): Promise<{ valid: boolean }> {
  const user = await resolveReferrer(code);
  if (!user) return { valid: false };
  return { valid: true };
}
