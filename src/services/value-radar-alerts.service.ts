/**
 * Value Radar Alerts — notifies users when stocks they own or watch
 * transition into deep_value territory.
 *
 * Tier 1 (real-time): Push when a holding/watchlist stock enters deep_value
 * Tier 2 (daily digest): Single morning notification summarizing all tier changes
 *
 * Anti-flood:
 *  - 7-day cooldown per stock per user (no re-alert for same stock)
 *  - Max 3 push notifications per user per day
 *  - Only fires on tier TRANSITIONS (not while staying in same tier)
 */
import prisma from '../utils/prisma';
import { getValueRadarData, ValueRadarStock } from './value-radar.service';
import { sendPushToUser, sendNativePushToUser } from './push.service';
import { logNotification } from './notifications.service';
import { getMarketSession } from '../utils/market-hours';

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DAILY_CAP = 3;

// ─── Tier 1: Real-time alerts on tier transitions ───────────────────

export async function evaluateValueRadarAlerts(): Promise<void> {
  const session = getMarketSession();
  if (session === 'CLOSED') return;

  // 1. Get current Value Radar data
  const radarData = await getValueRadarData();
  if (!radarData.stocks.length) return;

  const currentTiers = new Map<string, ValueRadarStock>();
  for (const stock of radarData.stocks) {
    currentTiers.set(stock.ticker, stock);
  }

  // 2. Load previous tier snapshot
  const snapshots = await prisma.valueRadarTierSnapshot.findMany();
  const previousTiers = new Map(snapshots.map(s => [s.ticker, s.tier]));

  // First-run guard: if snapshot is empty, seed it and skip alerting.
  // Otherwise every deep_value stock would trigger an alert on first deploy.
  if (previousTiers.size === 0) {
    console.log(`[Value Radar Alerts] First run — seeding snapshot for ${currentTiers.size} tickers, no alerts`);
    await updateTierSnapshot(currentTiers);
    return;
  }

  // 3. Find stocks that just entered deep_value (transition detection)
  const newDeepValue: ValueRadarStock[] = [];
  for (const [ticker, stock] of currentTiers) {
    if (stock.tier === 'deep_value') {
      const prevTier = previousTiers.get(ticker);
      if (prevTier !== 'deep_value') {
        newDeepValue.push(stock);
      }
    }
  }

  // 4. Update snapshot with current tiers (do this regardless of alerts)
  await updateTierSnapshot(currentTiers);

  if (newDeepValue.length === 0) return;

  console.log(`[Value Radar Alerts] ${newDeepValue.length} stocks entered deep_value: ${newDeepValue.map(s => s.ticker).join(', ')}`);

  // 5. Find all users with value_radar alert enabled
  const enabledAlerts = await prisma.alert.findMany({
    where: { type: 'value_radar', enabled: true, userId: { not: null } },
    select: { id: true, userId: true },
  });

  if (enabledAlerts.length === 0) return;

  // 6. For each user, check holdings + watchlists and send alerts
  for (const alert of enabledAlerts) {
    const userId = alert.userId!;
    try {
      await processUserAlerts(alert.id, userId, newDeepValue);
    } catch (err) {
      console.error(`[Value Radar Alerts] Failed for user ${userId}:`, err);
    }
  }
}

async function processUserAlerts(
  alertId: string,
  userId: string,
  newDeepValue: ValueRadarStock[],
): Promise<void> {
  // Get user's holding tickers
  const holdings = await prisma.holding.findMany({
    where: { userId, shares: { gt: 0 } },
    select: { ticker: true },
  });
  const holdingTickers = new Set(holdings.map(h => h.ticker.toUpperCase()));

  // Get user's watchlist tickers
  const watchlistHoldings = await prisma.watchlistHolding.findMany({
    where: { watchlist: { userId } },
    select: { ticker: true },
  });
  const watchlistTickers = new Set(watchlistHoldings.map(w => w.ticker.toUpperCase()));

  // Filter to stocks the user cares about
  const relevant = newDeepValue.filter(
    s => holdingTickers.has(s.ticker) || watchlistTickers.has(s.ticker),
  );

  if (relevant.length === 0) return;

  // Check daily cap
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayAlerts = await prisma.alertEvent.count({
    where: {
      alertId,
      createdAt: { gte: todayStart },
    },
  });
  if (todayAlerts >= DAILY_CAP) return;

  const remaining = DAILY_CAP - todayAlerts;

  // Check cooldown per stock — filter out recently alerted
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS);
  const recentEvents = await prisma.alertEvent.findMany({
    where: { alertId, createdAt: { gte: cooldownCutoff } },
    select: { data: true },
  });

  const recentlyAlertedTickers = new Set<string>();
  for (const ev of recentEvents) {
    try {
      const parsed = JSON.parse(ev.data || '{}');
      if (parsed.ticker) recentlyAlertedTickers.add(parsed.ticker);
      if (Array.isArray(parsed.tickers)) {
        for (const t of parsed.tickers) recentlyAlertedTickers.add(t);
      }
    } catch { /* skip malformed */ }
  }

  const toAlert = relevant
    .filter(s => !recentlyAlertedTickers.has(s.ticker))
    .slice(0, remaining);

  if (toAlert.length === 0) return;

  // Separate into holdings vs watchlist-only
  const holdingAlerts = toAlert.filter(s => holdingTickers.has(s.ticker));
  const watchlistAlerts = toAlert.filter(
    s => !holdingTickers.has(s.ticker) && watchlistTickers.has(s.ticker),
  );

  // Build notification message
  const parts: string[] = [];
  if (holdingAlerts.length > 0) {
    const tickers = holdingAlerts.map(s => s.ticker).join(', ');
    parts.push(
      holdingAlerts.length === 1
        ? `${tickers} (you own this) entered Deep Value at P/E ${holdingAlerts[0].currentPE.toFixed(1)} (${holdingAlerts[0].discountPct.toFixed(0)}% below 10Y avg)`
        : `${holdingAlerts.length} holdings entered Deep Value: ${tickers}`,
    );
  }
  if (watchlistAlerts.length > 0) {
    const tickers = watchlistAlerts.map(s => s.ticker).join(', ');
    parts.push(
      watchlistAlerts.length === 1
        ? `${tickers} (watchlist) entered Deep Value at P/E ${watchlistAlerts[0].currentPE.toFixed(1)}`
        : `${watchlistAlerts.length} watchlist stocks entered Deep Value: ${tickers}`,
    );
  }

  const message = parts.join('. ');
  const allTickers = toAlert.map(s => s.ticker);

  // Create AlertEvent
  await prisma.alertEvent.create({
    data: {
      alertId,
      message,
      data: JSON.stringify({
        tickers: allTickers,
        stocks: toAlert.map(s => ({
          ticker: s.ticker,
          currentPE: s.currentPE,
          avgPE: s.avgPE,
          discountPct: s.discountPct,
          price: s.price,
          changePercent: s.changePercent,
          isHolding: holdingTickers.has(s.ticker),
        })),
      }),
    },
  });

  // Push notifications — deep-link to the primary stock
  const primaryTicker = allTickers[0];
  const pushPayload = {
    title: 'Value Radar',
    body: message,
    tag: 'value-radar-alert',
    data: { type: 'value_radar', ticker: primaryTicker, url: `/stock/${primaryTicker}` },
  };

  sendPushToUser(userId, pushPayload).catch(() => {});
  sendNativePushToUser(userId, pushPayload).catch(() => {});

  // Audit log (dedup via refKey)
  const refKey = `value_radar:${allTickers.sort().join(',')}:${new Date().toISOString().slice(0, 10)}`;
  logNotification({
    userId,
    type: 'value_radar_alert',
    status: 'sent',
    channel: 'push',
    title: 'Value Radar',
    message,
    refKey,
    payload: { tickers: allTickers },
  }).catch(() => {});

  console.log(`[Value Radar Alerts] Sent to user ${userId}: ${allTickers.join(', ')}`);
}

// ─── Tier 2: Daily Digest ───────────────────────────────────────────

export async function sendValueRadarDigest(): Promise<void> {
  // Digest summarizes yesterday's Tier 1 alerts — no snapshot needed.
  // Pull recent AlertEvents created by the real-time evaluator in the last 24h.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const enabledAlerts = await prisma.alert.findMany({
    where: { type: 'value_radar', enabled: true, userId: { not: null } },
    select: { id: true, userId: true },
  });

  if (enabledAlerts.length === 0) return;

  let digestsSent = 0;

  for (const alert of enabledAlerts) {
    const userId = alert.userId!;

    try {
      // Get recent non-digest alert events for this user
      const recentEvents = await prisma.alertEvent.findMany({
        where: { alertId: alert.id, createdAt: { gte: since } },
        select: { message: true, data: true },
      });

      // Parse tickers from events, skip digest events
      const tickersSet = new Set<string>();
      for (const ev of recentEvents) {
        try {
          const parsed = JSON.parse(ev.data || '{}');
          if (parsed.type === 'digest') continue; // skip old digests
          if (Array.isArray(parsed.tickers)) {
            for (const t of parsed.tickers) tickersSet.add(t);
          }
        } catch { /* skip */ }
      }

      if (tickersSet.size === 0) continue;

      const tickers = Array.from(tickersSet);
      const body = `${tickers.length} stock${tickers.length > 1 ? 's' : ''} entered Deep Value in the last 24h: ${tickers.join(', ')}`;
      const refKey = `value_radar_digest:${new Date().toISOString().slice(0, 10)}`;

      // Dedup: one digest per user per day
      const logged = await logNotification({
        userId,
        type: 'value_radar_digest',
        status: 'sent',
        channel: 'push',
        title: 'Value Radar Daily',
        message: body,
        refKey,
        payload: { tickers },
      });

      if (!logged) continue; // Already sent today

      await prisma.alertEvent.create({
        data: {
          alertId: alert.id,
          message: `Daily Digest: ${body}`,
          data: JSON.stringify({ type: 'digest', tickers }),
        },
      });

      const pushPayload = {
        title: 'Value Radar Daily',
        body,
        tag: 'value-radar-digest',
        data: { type: 'value_radar', ticker: tickers[0], url: `/stock/${tickers[0]}` },
      };
      sendPushToUser(userId, pushPayload).catch(() => {});
      sendNativePushToUser(userId, pushPayload).catch(() => {});
      digestsSent++;
    } catch (err) {
      console.error(`[Value Radar Digest] Failed for user ${userId}:`, err);
    }
  }

  if (digestsSent > 0) {
    console.log(`[Value Radar Digest] Sent ${digestsSent} digests`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function tierRank(tier: string): number {
  switch (tier) {
    case 'deep_value': return 0;
    case 'attractive': return 1;
    case 'fair': return 2;
    case 'expensive': return 3;
    default: return 4;
  }
}

async function updateTierSnapshot(currentTiers: Map<string, ValueRadarStock>): Promise<void> {
  const entries = Array.from(currentTiers.values());
  const BATCH = 50;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(stock =>
        prisma.valueRadarTierSnapshot.upsert({
          where: { ticker: stock.ticker },
          create: { ticker: stock.ticker, tier: stock.tier, updatedAt: new Date() },
          update: { tier: stock.tier, updatedAt: new Date() },
        }),
      ),
    );
  }
}
