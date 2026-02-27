const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const userId = '9923e8c3-797d-459c-8386-9108ba1540b5';
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true } });
  if (!user) { console.log('[delete-test-user] Not found - already deleted'); return; }
  console.log('[delete-test-user] Deleting:', user.username);
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
  console.log('[delete-test-user] Done');
}
main().catch(e => console.error('[delete-test-user] Error:', e.message)).finally(() => prisma.$disconnect());
