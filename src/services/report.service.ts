import prisma from '../utils/prisma';

export async function reportUser(
  reporterUserId: string,
  reportedUserId: string,
  reason: string,
  description?: string,
  context?: string,
) {
  // Can't report yourself
  if (reporterUserId === reportedUserId) {
    const err = new Error('Cannot report yourself');
    (err as any).status = 400;
    throw err;
  }

  // Reported user must exist
  const reported = await prisma.user.findUnique({ where: { id: reportedUserId }, select: { id: true } });
  if (!reported) {
    const err = new Error('User not found');
    (err as any).status = 404;
    throw err;
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Max 5 reports per 24h per reporter
  const recentCount = await prisma.userReport.count({
    where: {
      reporterUserId,
      createdAt: { gte: oneDayAgo },
    },
  });
  if (recentCount >= 5) {
    const err = new Error('Too many reports. Please try again later.');
    (err as any).status = 429;
    throw err;
  }

  // No duplicate same-reporter + same-reported + same-reason within 24h
  const duplicate = await prisma.userReport.findFirst({
    where: {
      reporterUserId,
      reportedUserId,
      reason,
      createdAt: { gte: oneDayAgo },
    },
  });
  if (duplicate) {
    const err = new Error('You have already reported this user for this reason recently');
    (err as any).status = 409;
    throw err;
  }

  return prisma.userReport.create({
    data: {
      reporterUserId,
      reportedUserId,
      reason,
      description,
      context,
    },
  });
}
