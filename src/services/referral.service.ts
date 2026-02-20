import prisma from '../utils/prisma';

/**
 * Process a referral during signup.
 * Looks up the referrer by username (referral code = username),
 * sets referredBy on the new user, and creates a Referral record.
 */
export async function processReferral(
  referredUserId: string,
  referralCode: string
): Promise<{ referrerId: string } | null> {
  // Referral code is the referrer's username
  const referrer = await prisma.user.findUnique({
    where: { username: referralCode },
    select: { id: true },
  });

  if (!referrer || referrer.id === referredUserId) return null;

  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: referredUserId },
        data: { referredBy: referrer.id },
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
 */
export async function validateReferralCode(code: string): Promise<{ valid: boolean; displayName?: string }> {
  const user = await prisma.user.findUnique({
    where: { username: code },
    select: { displayName: true },
  });
  if (!user) return { valid: false };
  return { valid: true, displayName: user.displayName };
}
