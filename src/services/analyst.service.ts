import prisma from '../utils/prisma';
import axios, { AxiosError } from 'axios';
import { config } from '../config';
import { sendPushToUser } from './push.service';



const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
const TARGET_CHANGE_THRESHOLD = 0.05; // 5% change triggers notification

interface FinnhubPriceTarget {
  targetHigh: number;
  targetLow: number;
  targetMean: number;
  targetMedian: number;
  lastUpdated: string;
}

interface FinnhubRecommendation {
  buy: number;
  hold: number;
  period: string;
  sell: number;
  strongBuy: number;
  strongSell: number;
  symbol: string;
}

interface AnalystData {
  targetHigh: number | null;
  targetLow: number | null;
  targetMean: number | null;
  targetMedian: number | null;
  strongBuy: number | null;
  buy: number | null;
  hold: number | null;
  sell: number | null;
  strongSell: number | null;
}

// Track if price-target endpoint is accessible (free tier returns 403)
let priceTargetDisabled = false;

async function fetchPriceTarget(ticker: string): Promise<FinnhubPriceTarget | null> {
  if (priceTargetDisabled) return null;
  try {
    const response = await axios.get<FinnhubPriceTarget>(`${FINNHUB_BASE_URL}/stock/price-target`, {
      params: { symbol: ticker.toUpperCase(), token: config.finnhubApiKey },
      timeout: 5000,
    });
    // Validate response has actual data
    if (!response.data || response.data.targetMean === 0) {
      return null;
    }
    return response.data;
  } catch (error: unknown) {
    if (error instanceof AxiosError && error.response?.status === 403) {
      console.warn(`[Analyst] Price target endpoint requires premium plan â€” disabling for this session`);
      priceTargetDisabled = true;
    }
    return null;
  }
}

let recommendationsDisabled = false;

async function fetchRecommendations(ticker: string): Promise<FinnhubRecommendation | null> {
  if (recommendationsDisabled) return null;
  try {
    const response = await axios.get<FinnhubRecommendation[]>(`${FINNHUB_BASE_URL}/stock/recommendation`, {
      params: { symbol: ticker.toUpperCase(), token: config.finnhubApiKey },
      timeout: 5000,
    });
    // Return most recent recommendation
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (error: unknown) {
    if (error instanceof AxiosError && error.response?.status === 403) {
      console.warn(`[Analyst] Recommendations endpoint requires premium plan â€” disabling for this session`);
      recommendationsDisabled = true;
    }
    return null;
  }
}

function getRatingLabel(data: AnalystData): string {
  const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = data;
  const total = (strongBuy || 0) + (buy || 0) + (hold || 0) + (sell || 0) + (strongSell || 0);
  if (total === 0) return 'No Rating';

  const bullish = (strongBuy || 0) + (buy || 0);
  const bearish = (sell || 0) + (strongSell || 0);
  const neutral = hold || 0;

  if (bullish > bearish && bullish > neutral) {
    return (strongBuy || 0) > (buy || 0) ? 'Strong Buy' : 'Buy';
  } else if (bearish > bullish && bearish > neutral) {
    return (strongSell || 0) > (sell || 0) ? 'Strong Sell' : 'Sell';
  }
  return 'Hold';
}

export async function checkAnalystUpdates(tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;

  console.log(`[Analyst] Checking analyst updates for ${tickers.length} tickers...`);

  for (const ticker of tickers) {
    try {
      // Add delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));

      // Fetch current analyst data
      const [priceTarget, recommendations] = await Promise.all([
        fetchPriceTarget(ticker),
        fetchRecommendations(ticker),
      ]);

      if (!priceTarget && !recommendations) {
        continue; // No analyst data available for this ticker
      }

      const currentData: AnalystData = {
        targetHigh: priceTarget?.targetHigh ?? null,
        targetLow: priceTarget?.targetLow ?? null,
        targetMean: priceTarget?.targetMean ?? null,
        targetMedian: priceTarget?.targetMedian ?? null,
        strongBuy: recommendations?.strongBuy ?? null,
        buy: recommendations?.buy ?? null,
        hold: recommendations?.hold ?? null,
        sell: recommendations?.sell ?? null,
        strongSell: recommendations?.strongSell ?? null,
      };

      // Get previous snapshot
      const previousSnapshot = await prisma.analystSnapshot.findUnique({
        where: { ticker: ticker.toUpperCase() },
      });

      if (!previousSnapshot) {
        // First time seeing this ticker - just store snapshot, no notification
        await prisma.analystSnapshot.create({
          data: {
            ticker: ticker.toUpperCase(),
            ...currentData,
            lastUpdated: new Date(),
          },
        });
        console.log(`[Analyst] Created initial snapshot for ${ticker}`);
        continue;
      }

      // Compare and detect changes
      const events: { type: string; message: string; changePct?: number }[] = [];

      // Check price target change
      if (currentData.targetMean && previousSnapshot.targetMean) {
        const changePct = (currentData.targetMean - previousSnapshot.targetMean) / previousSnapshot.targetMean;
        if (Math.abs(changePct) >= TARGET_CHANGE_THRESHOLD) {
          const direction = changePct > 0 ? 'raised' : 'lowered';
          const pctStr = (Math.abs(changePct) * 100).toFixed(0);
          events.push({
            type: 'target_change',
            message: `${ticker} price target ${direction} to $${currentData.targetMean.toFixed(2)} (${changePct > 0 ? '+' : ''}${pctStr}%)`,
            changePct: changePct * 100,
          });
        }
      }

      // Check rating change
      const oldRating = getRatingLabel({
        strongBuy: previousSnapshot.strongBuy,
        buy: previousSnapshot.buy,
        hold: previousSnapshot.hold,
        sell: previousSnapshot.sell,
        strongSell: previousSnapshot.strongSell,
        targetHigh: null, targetLow: null, targetMean: null, targetMedian: null,
      });
      const newRating = getRatingLabel(currentData);

      if (oldRating !== newRating && oldRating !== 'No Rating' && newRating !== 'No Rating') {
        const isUpgrade =
          (newRating === 'Strong Buy' && oldRating !== 'Strong Buy') ||
          (newRating === 'Buy' && (oldRating === 'Hold' || oldRating === 'Sell' || oldRating === 'Strong Sell')) ||
          (newRating === 'Hold' && (oldRating === 'Sell' || oldRating === 'Strong Sell'));

        const action = isUpgrade ? 'upgraded' : 'downgraded';
        events.push({
          type: 'rating_change',
          message: `${ticker} ${action} to ${newRating} (was ${oldRating})`,
        });
      }

      // Create events and update snapshot
      if (events.length > 0) {
        await prisma.$transaction([
          ...events.map(event =>
            prisma.analystEvent.create({
              data: {
                ticker: ticker.toUpperCase(),
                eventType: event.type,
                message: event.message,
                oldValue: JSON.stringify(previousSnapshot),
                newValue: JSON.stringify(currentData),
                changePct: event.changePct,
                read: false,
              },
            })
          ),
          prisma.analystSnapshot.update({
            where: { ticker: ticker.toUpperCase() },
            data: {
              ...currentData,
              lastUpdated: new Date(),
            },
          }),
        ]);

        // Fire-and-forget push to all users holding this ticker
        const holders = await prisma.holding.findMany({
          where: { ticker: ticker.toUpperCase(), shares: { gt: 0 }, userId: { not: null } },
          select: { userId: true },
          distinct: ['userId'],
        });
        for (const event of events) {
          console.log(`[Analyst] ${event.message}`);
          for (const holder of holders) {
            if (holder.userId) {
              sendPushToUser(holder.userId, {
                title: `Analyst Update: ${ticker.toUpperCase()}`,
                body: event.message,
                tag: `analyst-${ticker.toUpperCase()}`,
                data: { type: 'analyst', url: '/' },
              }).catch(() => {});
            }
          }
        }
      } else {
        // Just update the snapshot timestamp
        await prisma.analystSnapshot.update({
          where: { ticker: ticker.toUpperCase() },
          data: { lastUpdated: new Date() },
        });
      }
    } catch (error) {
      console.error(`[Analyst] Error processing ${ticker}:`, error);
    }
  }

  console.log(`[Analyst] Finished checking analyst updates`);
}

export async function getAnalystEvents(limit = 50, ticker?: string, userId?: string): Promise<any[]> {
  const events = await prisma.analystEvent.findMany({
    where: ticker ? { ticker: ticker.toUpperCase() } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  if (!userId) return events;

  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { analystLastReadAt: true },
  });
  const lastReadAt = settings?.analystLastReadAt;

  return events.map((event) => ({
    ...event,
    read: lastReadAt ? event.createdAt <= lastReadAt : false,
  }));
}

export async function getUnreadAnalystCount(userId: string): Promise<number> {
  // Per-user unread: events created after user's last read timestamp
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { analystLastReadAt: true },
  });
  const lastReadAt = settings?.analystLastReadAt;
  return prisma.analystEvent.count({
    where: lastReadAt ? { createdAt: { gt: lastReadAt } } : {},
  });
}


export async function markAllAnalystEventsRead(userId: string): Promise<void> {
  await prisma.userSettings.upsert({
    where: { userId },
    update: { analystLastReadAt: new Date() },
    create: { userId, analystLastReadAt: new Date() },
  });
}

export async function getAnalystSnapshot(ticker: string): Promise<any | null> {
  return prisma.analystSnapshot.findUnique({
    where: { ticker: ticker.toUpperCase() },
  });
}

