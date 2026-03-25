import prisma from '../utils/prisma';

/**
 * Get the list of user IDs that the given user has blocked.
 * Used by feed/post queries to exclude blocked users' content.
 */
export async function getBlockedUserIds(userId: string): Promise<string[]> {
  const blocks = await prisma.userBlock.findMany({
    where: { blockerId: userId },
    select: { blockedId: true },
  });
  return blocks.map(b => b.blockedId);
}

/**
 * Block a user. Also removes any follow relationship in both directions.
 */
export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) {
    throw Object.assign(new Error('Cannot block yourself'), { status: 400 });
  }

  // Verify the target user exists
  const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }

  // Upsert the block (idempotent)
  await prisma.userBlock.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  });

  // Remove follow relationships in both directions
  await prisma.follow.deleteMany({
    where: {
      OR: [
        { followerId: blockerId, followingId: blockedId },
        { followerId: blockedId, followingId: blockerId },
      ],
    },
  });
}

/**
 * Unblock a user.
 */
export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await prisma.userBlock.deleteMany({
    where: { blockerId, blockedId },
  });
}

/**
 * Get the list of blocked users with basic profile info.
 */
export async function getBlockedUsers(blockerId: string): Promise<
  { id: string; username: string; displayName: string; avatarUrl: string | null; blockedAt: string }[]
> {
  const blocks = await prisma.userBlock.findMany({
    where: { blockerId },
    orderBy: { createdAt: 'desc' },
    include: {
      blocked: {
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      },
    },
  });

  return blocks.map(b => ({
    id: b.blocked.id,
    username: b.blocked.username,
    displayName: b.blocked.displayName,
    avatarUrl: b.blocked.avatarUrl,
    blockedAt: b.createdAt.toISOString(),
  }));
}

/**
 * Check if blockerId has blocked blockedId.
 */
export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const block = await prisma.userBlock.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    select: { id: true },
  });
  return !!block;
}
