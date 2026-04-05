import prisma from '../utils/prisma';
import { getPortfolioBriefing } from './perplexity-briefing.service';

/**
 * Scheduled pre-generation of weekly and monthly portfolio briefs.
 *
 * Runs hourly. On each tick, finds users whose LOCAL time is currently
 * Sunday 06:00-06:59 (weekly) or the 1st of the month 06:00-06:59 (monthly),
 * then calls getPortfolioBriefing() to pre-generate + cache their brief.
 *
 * Scope: only generation timing. No new UI, no push notifications, no
 * delivery log — the existing briefingCache handles idempotency within the hour.
 */

interface LocalParts {
  weekday: string; // "Sun" | "Mon" | ...
  day: string;     // "1" | "2" | ... (unpadded)
  hour: string;    // "00" | "01" | ... | "23" (zero-padded)
}

const ET_FALLBACK = 'America/New_York';

/**
 * Validate a timezone string; fall back to ET if it's invalid/empty.
 * Keeps the cycle loop from crashing on one bad user row.
 */
export function resolveTimezone(tz: string | null | undefined): string {
  if (!tz) return ET_FALLBACK;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return ET_FALLBACK;
  }
}

export function getLocalParts(timezone: string, now: Date = new Date()): LocalParts {
  const safeTz = resolveTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    weekday: 'short',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const out: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return { weekday: out.weekday, day: out.day, hour: out.hour };
}

export function isLocalSundaySixAm(timezone: string, now: Date = new Date()): boolean {
  const p = getLocalParts(timezone, now);
  return p.weekday === 'Sun' && p.hour === '06';
}

export function isLocalFirstSixAm(timezone: string, now: Date = new Date()): boolean {
  const p = getLocalParts(timezone, now);
  return p.day === '1' && p.hour === '06';
}

/**
 * For each user with holdings, pre-generate their weekly brief if their local
 * time is currently Sunday 06:00-06:59. Falls back to America/New_York for
 * users without a timezone set.
 */
/** Retry a brief generation up to N times with exponential backoff. */
async function generateWithRetry(
  userId: string,
  period: 'weekly' | 'monthly',
  tz: string,
  maxAttempts = 3,
): Promise<{ success: boolean; attempts: number; error?: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await getPortfolioBriefing(userId, undefined, period, tz);
      return { success: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        // Exponential backoff: 2s, 4s.
        const delayMs = 2000 * attempt;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  return {
    success: false,
    attempts: maxAttempts,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

export async function runWeeklyBriefCycle(): Promise<void> {
  const now = new Date();
  // Match the filter used by preGenerateDailyReports so we only pre-gen for
  // users with positive-share holdings (skip zero-share stale rows).
  const holdings = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });
  const userIds = holdings.map(h => h.userId).filter((id): id is string => Boolean(id));
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true } })
    : [];

  let fired = 0;
  let failed = 0;
  for (const user of users) {
    const tz = resolveTimezone(user.timezone);
    if (!isLocalSundaySixAm(tz, now)) continue;
    const result = await generateWithRetry(user.id, 'weekly', tz);
    if (result.success) {
      fired += 1;
    } else {
      failed += 1;
      console.error(`[weekly-brief] generation failed for user ${user.id} after ${result.attempts} attempts: ${result.error}`);
    }
  }

  if (fired > 0 || failed > 0) {
    console.log(`[weekly-brief] pre-generated ${fired} brief(s), ${failed} failed`);
  }
}

/**
 * For each user with holdings, pre-generate their monthly brief if their local
 * time is currently the 1st of the month at 06:00-06:59. Falls back to
 * America/New_York for users without a timezone set.
 */
export async function runMonthlyBriefCycle(): Promise<void> {
  const now = new Date();
  const holdings = await prisma.holding.findMany({
    select: { userId: true },
    distinct: ['userId'],
    where: { shares: { gt: 0 }, userId: { not: null } },
  });
  const userIds = holdings.map(h => h.userId).filter((id): id is string => Boolean(id));
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true } })
    : [];

  let fired = 0;
  let failed = 0;
  for (const user of users) {
    const tz = resolveTimezone(user.timezone);
    if (!isLocalFirstSixAm(tz, now)) continue;
    const result = await generateWithRetry(user.id, 'monthly', tz);
    if (result.success) {
      fired += 1;
    } else {
      failed += 1;
      console.error(`[monthly-brief] generation failed for user ${user.id} after ${result.attempts} attempts: ${result.error}`);
    }
  }

  if (fired > 0 || failed > 0) {
    console.log(`[monthly-brief] pre-generated ${fired} brief(s), ${failed} failed`);
  }
}
