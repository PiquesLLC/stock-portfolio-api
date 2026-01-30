import { PrismaClient } from '@prisma/client';
import { getFollowingIds } from './follow.service';

const prisma = new PrismaClient();

export type ActivityType = 'holding_added' | 'holding_removed' | 'holding_updated';

export interface ActivityPayload {
  ticker: string;
  shares?: number;
  previousShares?: number;
  averageCost?: number;
}

export interface ActivityEventResponse {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  type: ActivityType;
  payload: ActivityPayload;
  createdAt: string;
}

export async function createActivityEvent(
  userId: string,
  type: ActivityType,
  payload: ActivityPayload
): Promise<void> {
  await prisma.activityEvent.create({
    data: {
      userId,
      type,
      payload: JSON.stringify(payload),
    },
  });
}

export async function getFeed(
  userId: string,
  limit = 50,
  before?: string
): Promise<ActivityEventResponse[]> {
  const followingIds = await getFollowingIds(userId);
  if (followingIds.length === 0) return [];

  const where: Record<string, unknown> = {
    userId: { in: followingIds },
  };
  if (before) {
    where.createdAt = { lt: new Date(before) };
  }

  const events = await prisma.activityEvent.findMany({
    where,
    include: {
      user: {
        select: { id: true, username: true, displayName: true, profilePublic: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return events
    .filter((e) => e.user.profilePublic)
    .map((e) => ({
      id: e.id,
      userId: e.userId,
      username: e.user.username,
      displayName: e.user.displayName,
      type: e.type as ActivityType,
      payload: JSON.parse(e.payload) as ActivityPayload,
      createdAt: e.createdAt.toISOString(),
    }));
}

export async function getUserActivity(
  userId: string,
  limit = 20
): Promise<ActivityEventResponse[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, displayName: true, profilePublic: true },
  });
  if (!user) return [];

  const events = await prisma.activityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return events.map((e) => ({
    id: e.id,
    userId,
    username: user.username,
    displayName: user.displayName,
    type: e.type as ActivityType,
    payload: JSON.parse(e.payload) as ActivityPayload,
    createdAt: e.createdAt.toISOString(),
  }));
}
