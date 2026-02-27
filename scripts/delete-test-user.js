const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const userId = 'f6d03d18-1591-477b-b0ac-f0790edad492';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true }
  });

  if (!user) {
    console.log('User not found - already deleted');
    return;
  }

  console.log('Deleting user:', user.username, user.email);

  await prisma.$transaction(async (tx) => {
    await tx.plaidAccount.deleteMany({ where: { plaidItem: { userId } } });
    await tx.plaidItem.deleteMany({ where: { userId } });
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.mfaMethod.deleteMany({ where: { userId } });
    await tx.mfaChallenge.deleteMany({ where: { userId } });
    await tx.mfaBackupCode.deleteMany({ where: { userId } });
    await tx.emailOtpCode.deleteMany({ where: { userId } });
    await tx.activityEvent.deleteMany({ where: { userId } });
    await tx.follow.deleteMany({ where: { followerId: userId } });
    await tx.follow.deleteMany({ where: { followingId: userId } });
    await tx.alertEvent.deleteMany({ where: { alert: { userId } } });
    await tx.alert.deleteMany({ where: { userId } });
    await tx.priceAlertEvent.deleteMany({ where: { priceAlert: { userId } } });
    await tx.priceAlert.deleteMany({ where: { userId } });
    await tx.holding.deleteMany({ where: { userId } });
    await tx.portfolioSnapshot.deleteMany({ where: { userId } });
    await tx.portfolioCompositionChange.deleteMany({ where: { userId } });
    await tx.watchlist.deleteMany({ where: { userId } });
    await tx.dividendReinvestment.deleteMany({ where: { userId } });
    await tx.dividendCredit.deleteMany({ where: { userId } });
    await tx.lot.deleteMany({ where: { userId } });
    await tx.transaction.deleteMany({ where: { userId } });
    await tx.milestoneEvent.deleteMany({ where: { userId } });
    await tx.anomalyEvent.deleteMany({ where: { userId } });
    await tx.notificationAuditLog.deleteMany({ where: { userId } });
    await tx.leaderboardCache.deleteMany({ where: { userId } });
    await tx.userSettings.deleteMany({ where: { userId } });
    await tx.consentRecord.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
  });

  console.log('Done - user deleted');
}

main()
  .catch(e => { console.error('Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
