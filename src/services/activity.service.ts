import prisma from '../utils/prisma';
import { getFollowingIds } from './follow.service';


export type ActivityType = 'holding_added' | 'holding_removed' | 'holding_updated';

export interface ActivityPayload {
  ticker: string;
  shares?: number;
  previousShares?: number;
  averageCost?: number;
  previousAverageCost?: number;
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

function parseActivityPayload(raw: string, eventId: string): ActivityPayload | null {
  try {
    return JSON.parse(raw) as ActivityPayload;
  } catch {
    console.warn(`[Activity] Skipping malformed payload for event ${eventId}`);
    return null;
  }
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

  // Platform-wide minimum 24hr trade delay for ALL users.
  // Creators may have a higher delay (48/72hr) — use the greater of the two.
  const MINIMUM_DELAY_HOURS = 24;
  const creators = await prisma.creator.findMany({
    where: { userId: { in: followingIds }, status: 'active' },
    select: { userId: true, visibility: { select: { tradeDelayHours: true } } },
  });
  const creatorDelayMap = new Map<string, number>();
  for (const c of creators) {
    const delay = c.visibility?.tradeDelayHours ?? 0;
    if (delay > MINIMUM_DELAY_HOURS) creatorDelayMap.set(c.userId, delay);
  }

  const where: Record<string, unknown> = {
    userId: { in: followingIds },
  };
  if (before) {
    where.createdAt = { lt: new Date(before) };
  }

  // Fetch extra events to account for delay-filtered ones being removed
  const events = await prisma.activityEvent.findMany({
    where,
    include: {
      user: {
        select: { id: true, username: true, displayName: true, profilePublic: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * 2, // Always fetch extra since all events are delay-filtered
  });

  const now = Date.now();
  return events
    .filter((e) => {
      if (!e.user.profilePublic) return false;
      // Apply trade delay: minimum 24hr for all users, creator delay if higher
      const delay = creatorDelayMap.get(e.userId) ?? MINIMUM_DELAY_HOURS;
      const cutoff = now - delay * 60 * 60 * 1000;
      if (e.createdAt.getTime() > cutoff) return false;
      return true;
    })
    .flatMap((e) => {
      const payload = parseActivityPayload(e.payload, e.id);
      if (!payload) return [];
      return [{
        id: e.id,
        userId: e.userId,
        username: e.user.username,
        displayName: e.user.displayName,
        type: e.type as ActivityType,
        payload,
        createdAt: e.createdAt.toISOString(),
      }];
    })
    .slice(0, limit);
}

export async function getUserActivityByTicker(
  userId: string,
  ticker: string,
  limit = 100
): Promise<ActivityEventResponse[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, displayName: true },
  });
  if (!user) return [];

  const events = await prisma.$queryRaw<
    { id: string; userId: string; type: string; payload: string; createdAt: Date }[]
  >`
    SELECT id, "userId", type, payload, "createdAt"
    FROM "ActivityEvent"
    WHERE "userId" = ${userId}
      AND JSON_EXTRACT(payload, '$.ticker') = ${ticker.toUpperCase()}
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `;

  return events.flatMap((e) => {
    const payload = parseActivityPayload(e.payload, e.id);
    if (!payload) return [];
    return [{
      id: e.id,
      userId,
      username: user.username,
      displayName: user.displayName,
      type: e.type as ActivityType,
      payload,
      createdAt: new Date(e.createdAt).toISOString(),
    }];
  });
}

export async function deleteActivityEvent(
  userId: string,
  eventId: string
): Promise<boolean> {
  const event = await prisma.activityEvent.findUnique({ where: { id: eventId } });
  if (!event || event.userId !== userId) return false;
  await prisma.activityEvent.delete({ where: { id: eventId } });
  return true;
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

  return events.flatMap((e) => {
    const payload = parseActivityPayload(e.payload, e.id);
    if (!payload) return [];
    return [{
      id: e.id,
      userId,
      username: user.username,
      displayName: user.displayName,
      type: e.type as ActivityType,
      payload,
      createdAt: e.createdAt.toISOString(),
    }];
  });
}

