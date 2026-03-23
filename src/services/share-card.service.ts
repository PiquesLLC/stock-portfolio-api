import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import prisma from '../utils/prisma';
import { getPortfolioChartData } from './snapshot.service';
import { getPortfolio } from './portfolio.service';
import { fetchHourlyCandles, fetchIntradayCandles, fetchStockDetails } from './market.service';

// Load and cache logos as base64 at startup
let _LOGO_B64 = '';
let _LOGO_TRANSPARENT_B64 = '';
try {
  const logoPath = path.join(__dirname, '..', '..', 'assets', 'north-signal-logo-80.png');
  if (fs.existsSync(logoPath)) {
    _LOGO_B64 = fs.readFileSync(logoPath).toString('base64');
  }
  const transparentPath = path.join(__dirname, '..', '..', 'assets', 'north-signal-logo-transparent.png');
  if (fs.existsSync(transparentPath)) {
    _LOGO_TRANSPARENT_B64 = fs.readFileSync(transparentPath).toString('base64');
  }
} catch {
  // logo optional
}


/**
 * Check if a user is a creator with an active trade delay.
 * Share cards and performance cards are public — they must not reveal
 * recent trading activity through return metrics or sparkline changes.
 */
async function hasActiveTradeDelay(userId: string): Promise<boolean> {
  const creator = await prisma.creator.findUnique({
    where: { userId },
    select: { status: true, visibility: { select: { tradeDelayHours: true } } },
  });
  return creator?.status === 'active' && (creator.visibility?.tradeDelayHours ?? 0) > 0;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function generateQrSvgGroup(url: string, x: number, y: number, size: number): Promise<string> {
  try {
    const svgStr = await QRCode.toString(url, {
      type: 'svg',
      margin: 0,
      width: size,
      color: { dark: '#ffffff', light: '#00000000' },
      errorCorrectionLevel: 'M',
    });
    // Extract the inner content (paths) from the SVG string and wrap in a positioned group
    const innerMatch = svgStr.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
    if (!innerMatch) return '';
    const viewBoxMatch = svgStr.match(/viewBox="([^"]*)"/);
    const viewBox = viewBoxMatch ? viewBoxMatch[1] : `0 0 ${size} ${size}`;
    return `<g transform="translate(${x},${y})">
      <svg width="${size}" height="${size}" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
        ${innerMatch[1]}
      </svg>
    </g>`;
  } catch {
    return '';
  }
}

interface StockShareCardData {
  ticker: string;
  companyName: string;
  exchange: string;
  currentPrice: number;
  changeValue: number;
  changePercent: number;
  periodLabel: string;
  marketStatus: string;
  sparklineValues: number[];
  sparklineDates: string[];
  previousClose: number;
  logoB64: string; // base64-encoded company logo
}

type ShareCardPeriod = '1D' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | 'ALL';

interface PerformanceShareCardData {
  username: string;
  displayName: string;
  period: ShareCardPeriod;
  periodLabel: string;
  currentValue: number;
  periodStartValue: number;
  periodChangeValue: number;
  periodChangePercent: number;
  sparklineValues: number[];
  sparklineDates: string[];
}

interface ChartPoint {
  time: number;
  value: number;
}

async function fetchLogoAsBase64(url: string): Promise<string> {
  if (!url) return '';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/png';
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function downsampleValues(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const step = (values.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => {
    const idx = Math.round(i * step);
    return values[idx];
  });
}

function normalizePeriod(period?: string): ShareCardPeriod {
  const normalized = (period ?? '1M').toUpperCase() as ShareCardPeriod;
  const valid: ShareCardPeriod[] = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', 'ALL'];
  return valid.includes(normalized) ? normalized : '1M';
}

export function filterPerformanceShareCardPoints(points: ChartPoint[], period: ShareCardPeriod, now = new Date()): ChartPoint[] {
  if (period !== '1D' || points.length <= 2) {
    return points;
  }

  const etDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });

  function getEtHourFloat(d: Date): { hourFloat: number; isWeekday: boolean; etDate: string } {
    const parts = etFormatter.formatToParts(d);
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
    return {
      hourFloat: hour + minute / 60,
      isWeekday: !['Sat', 'Sun'].includes(weekday),
      etDate: etDateFmt.format(d),
    };
  }

  const nowDate = new Date(now);
  const nowMs = nowDate.getTime();

  const datedPoints = points.map(point => {
    const etMeta = getEtHourFloat(new Date(point.time));
    return { point, ...etMeta };
  });

  // Use the most recent trading day represented in the data, not necessarily "today".
  // This keeps Friday's regular session on evenings/weekends instead of falling back
  // to the full 2-day window with overnight flat lines.
  const latestTradingDay = [...datedPoints]
    .reverse()
    .find(entry => entry.isWeekday)?.etDate;

  if (!latestTradingDay) {
    return points;
  }

  const sameDayRegularHours = datedPoints
    .filter(entry => entry.isWeekday && entry.etDate === latestTradingDay && entry.hourFloat >= 9.5 && entry.hourFloat < 16)
    .map(entry => entry.point);

  if (sameDayRegularHours.length >= 2) {
    return sameDayRegularHours;
  }

  const latestTradingDayPoints = datedPoints
    .filter(entry => entry.isWeekday && entry.etDate === latestTradingDay)
    .map(entry => entry.point);

  if (latestTradingDayPoints.length >= 2) {
    return latestTradingDayPoints;
  }

  const nowEt = etDateFmt.format(nowDate);
  const sameCalendarDayRegularHours = datedPoints
    .filter(entry => entry.isWeekday && entry.etDate === nowEt && entry.hourFloat >= 9.5 && entry.hourFloat < 16)
    .map(entry => entry.point);

  if (sameCalendarDayRegularHours.length >= 2) {
    return sameCalendarDayRegularHours;
  }

  // Fallback to the broader same-day session if a thin trading day or provider issue
  // would otherwise leave the card with too few points.
  const etOffNoon = new Date(`${latestTradingDay}T12:00:00Z`);
  const etNoonHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(etOffNoon).split(':')[0], 10);
  const etOffsetMs = (etNoonHour - 12) * 3600000;
  const latestTradingDay4amEt = new Date(`${latestTradingDay}T04:00:00Z`).getTime() - etOffsetMs;
  const sameTradingDayExpanded = points.filter(point => point.time >= latestTradingDay4amEt && point.time <= nowMs);

  if (sameTradingDayExpanded.length >= 2) {
    return sameTradingDayExpanded;
  }

  const todayExpanded = points.filter(point => {
    const { etDate } = getEtHourFloat(new Date(point.time));
    return etDate === nowEt;
  });
  return todayExpanded.length >= 2 ? todayExpanded : points;
}

async function getStockShareCardData(inputTicker: string, periodInput?: string): Promise<StockShareCardData | null> {
  const ticker = inputTicker.toUpperCase();
  const period = normalizePeriod(periodInput || '1W');
  const candleFetcher = period === '1D'
    ? fetchIntradayCandles(ticker).catch(() => [])
    : (['1W', '1M', '6M', 'YTD'].includes(period) ? fetchHourlyCandles(ticker, period as '1W' | '1M' | '6M' | 'YTD') : Promise.resolve([])).catch(() => []);

  const [details, candles] = await Promise.all([
    fetchStockDetails(ticker).catch(() => null),
    candleFetcher,
  ]);

  if (!details?.quote) return null;

  const currentPrice = details.quote.currentPrice;

  // Proper ET conversion using Intl (handles EST/EDT automatically)
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false,
    weekday: 'short',
  });
  function getEtHourFloat(d: Date): { hourFloat: number; isWeekday: boolean } {
    const parts = etFormatter.formatToParts(d);
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
    return { hourFloat: hour + minute / 60, isWeekday: !['Sat', 'Sun'].includes(weekday) };
  }

  // Build sparkline from candles — filter to regular market hours only (weekday 9:30 AM–4 PM ET)
  const marketCandles = candles.filter(c => {
    const d = new Date(c.time);
    const { hourFloat, isWeekday } = getEtHourFloat(d);
    return isWeekday && hourFloat >= 9.5 && hourFloat < 16;
  });
  const candleValues = marketCandles
    .map(c => c.close)
    .filter(v => Number.isFinite(v) && v > 0);

  // For period change: use daily candle data with date-based cutoff
  const dailyCloses = details.candles?.closes ?? [];
  const dailyDates = details.candles?.dates ?? [];
  const now = new Date();
  let cutoff: Date;
  let periodLabel: string;
  switch (period) {
    case '1D': cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 1); periodLabel = 'Today'; break;
    case '1W': cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7); periodLabel = 'Past Week'; break;
    case '1M': cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 1); periodLabel = 'Past Month'; break;
    case '3M': cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 3); periodLabel = 'Past 3 Months'; break;
    case '6M': cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 6); periodLabel = 'Past 6 Months'; break;
    case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); periodLabel = 'Year to Date'; break;
    case '1Y': cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - 1); periodLabel = 'Past Year'; break;
    case 'ALL': cutoff = new Date(0); periodLabel = 'All Time'; break;
    default: cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7); periodLabel = 'Past Week'; break;
  }

  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let startPrice = dailyCloses[0] ?? currentPrice;
  const filteredCloses: number[] = [];
  const filteredDates: string[] = [];
  for (let i = 0; i < dailyDates.length; i++) {
    if (dailyDates[i] >= cutoffStr) {
      if (filteredCloses.length === 0) startPrice = dailyCloses[i];
      filteredCloses.push(dailyCloses[i]);
      filteredDates.push(dailyDates[i]);
    }
  }

  // For 1D, use previousClose as the baseline (matches how the app shows daily change)
  const periodStartPrice = period === '1D'
    ? (details.quote.previousClose ?? startPrice)
    : startPrice;
  const changeValue = currentPrice - periodStartPrice;
  const changePercent = periodStartPrice > 0 ? (changeValue / periodStartPrice) * 100 : 0;

  // Use hourly candles if available, otherwise daily
  const rawValues = candleValues.length > 0 ? candleValues : (filteredCloses.length > 0 ? filteredCloses : [currentPrice, currentPrice]);
  const sparklineValues = downsampleValues(rawValues, 128);

  // Build date labels for the chart
  const rawDates = candleValues.length > 0
    ? marketCandles.filter(c => Number.isFinite(c.close) && c.close > 0).map(c => c.time)
    : (filteredDates.length > 0 ? filteredDates : []);
  const sparklineDates = downsampleValues(
    rawDates.length > 0 ? rawDates.map((_, i) => i) : [0, 1],
    64,
  ).map(idx => {
    const d = rawDates[Math.round(idx)];
    if (!d) return '';
    const date = new Date(d);
    if (period === '1D') {
      // Show time for intraday
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Market status (proper ET with DST)
  const { hourFloat: nowEtHour, isWeekday: nowIsWeekday } = getEtHourFloat(now);
  const isMarketOpen = nowIsWeekday && nowEtHour >= 9.5 && nowEtHour < 16;
  const isPreMarket = nowIsWeekday && nowEtHour >= 4 && nowEtHour < 9.5;
  const isAfterHours = nowIsWeekday && nowEtHour >= 16 && nowEtHour < 20;
  const marketStatus = isMarketOpen ? 'OPEN' : isPreMarket ? 'PRE-MARKET' : isAfterHours ? 'AFTER HOURS' : 'CLOSED';

  // Fetch company logo
  const logoB64 = await fetchLogoAsBase64(details.profile?.logo || '');

  return {
    ticker,
    companyName: details.profile?.name || ticker,
    exchange: details.profile?.exchange || '',
    currentPrice,
    changeValue,
    changePercent,
    periodLabel,
    marketStatus,
    sparklineValues,
    sparklineDates,
    previousClose: details.quote.previousClose ?? startPrice,
    logoB64,
  };
}

async function getPerformanceShareCardData(userId: string, periodInput: string): Promise<PerformanceShareCardData | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      username: true,
      displayName: true,
      profilePublic: true,
      holdingsVisibility: true,
    },
  });

  if (!user || !user.profilePublic) return null;

  // Don't generate performance cards for users who hide their holdings
  if (user.holdingsVisibility !== 'all') return null;

  const period = normalizePeriod(periodInput);

  // Fetch chart data and live portfolio in parallel
  const [chartData, livePortfolio] = await Promise.all([
    getPortfolioChartData(userId, period),
    getPortfolio(userId).catch(() => null),
  ]);
  let { points } = chartData;
  const { periodStartValue } = chartData;

  // Use live portfolio value for the headline so it matches the in-app display exactly.
  // Fall back to last chart point if live portfolio fetch fails.
  const headlineValue = livePortfolio
    ? livePortfolio.netEquity
    : (points.length > 0 ? points[points.length - 1].value : 0);

  points = filterPerformanceShareCardPoints(points, period);

  // Filter weekends and non-trading hours for non-1D periods (matches in-app chart).
  // Without this, the sparkline shows flat horizontal lines during weekends.
  if (period !== '1D' && points.length > 2) {
    const etHourFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const etDayFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short',
    });

    // Detect daily-resolution data (snapshots: ~1 point/day, >12h gap).
    // For daily data, only filter weekends — time-of-day filter would drop whole days.
    const gaps: number[] = [];
    for (let i = 1; i < Math.min(points.length, 10); i++) {
      gaps.push(points[i].time - points[i - 1].time);
    }
    const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const isDailyResolution = medianGap > 12 * 3600000;

    const tradingFiltered = points.filter(p => {
      const d = new Date(p.time);
      const wd = etDayFmt.format(d);
      if (wd === 'Sat' || wd === 'Sun') return false;
      if (isDailyResolution) return true;
      const hm = etHourFmt.format(d);
      const h = parseInt(hm.split(':')[0]);
      return h >= 4 && h < 20; // 4 AM – 8 PM ET
    });
    if (tradingFiltered.length >= 2) {
      points = tradingFiltered;
    }
  }

  // Trade delay: filter out recent points so chart sparkline doesn't reveal trade timing.
  // But never filter so aggressively that we end up with zero points — that
  // produces a broken $0 card.  If the delay would remove everything, skip it.
  const delayed = await hasActiveTradeDelay(userId);
  if (delayed) {
    const creator = await prisma.creator.findUnique({
      where: { userId },
      select: { visibility: { select: { tradeDelayHours: true } } },
    });
    const delayCutoff = Date.now() - (creator?.visibility?.tradeDelayHours ?? 24) * 60 * 60 * 1000;
    const filtered = points.filter(p => p.time <= delayCutoff);
    if (filtered.length >= 2) {
      points = filtered;
    }
  }

  const numValues = points.map(p => p.value);
  const numTimes = points.map(p => p.time);

  // Use live portfolio value and day change to match in-app display exactly.
  // For 1D, use the portfolio's own dayChange (price-based, immune to margin timing).
  // For other periods, compute from chart data as before.
  const currentValue = headlineValue;
  const periodChangeValue = (period === '1D' && livePortfolio)
    ? livePortfolio.dayChange
    : currentValue - periodStartValue;
  const periodChangePercent = (period === '1D' && livePortfolio)
    ? livePortfolio.dayChangePercent
    : (periodStartValue > 0 ? (periodChangeValue / periodStartValue) * 100 : 0);
  const sparklineValues = downsampleValues(numValues.length > 0 ? numValues : [currentValue, currentValue], 128);

  // Build date labels from timestamps
  const downsampledIndices = downsampleValues(
    numTimes.length > 0 ? numTimes.map((_, i) => i) : [0, 1],
    128,
  );
  const sparklineDates = downsampledIndices.map(idx => {
    const t = numTimes[Math.round(idx)];
    if (!t) return '';
    const date = new Date(t);
    if (period === '1D') {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const idealLabels: Record<string, string> = {
    '1D': 'Today', '1W': 'Past Week', '1M': 'Past Month',
    '3M': 'Past 3 Months', '6M': 'Past 6 Months', 'YTD': 'Year to Date',
    '1Y': 'Past Year', 'ALL': 'All Time',
  };
  const periodLabel = idealLabels[period] || period;

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    period,
    periodLabel,
    currentValue,
    periodStartValue,
    periodChangeValue,
    periodChangePercent,
    sparklineValues,
    sparklineDates,
  };
}

async function buildStockSvg(data: StockShareCardData): Promise<string> {
  const W = 1200;
  const H = 630;
  const GREEN = '#00c805';
  const RED = '#e8544e';
  const F = 'Inter, sans-serif';
  const positive = data.changePercent >= 0;
  const accent = positive ? GREEN : RED;

  const priceText = `$${data.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const changeValText = `${positive ? '+' : ''}${data.changeValue.toFixed(2)}`;
  const changePctText = `(${positive ? '+' : ''}${data.changePercent.toFixed(2)}%)`;

  // Chart area — generous, matching app proportions
  const chartL = 48;
  const chartR = W - 48;
  const chartT = 260;
  const chartB = 490;
  const chartW = chartR - chartL;
  const chartH = chartB - chartT;

  const vals = data.sparklineValues;
  const sparkMin = vals.length > 0 ? Math.min(...vals) : 0;
  const sparkMax = vals.length > 0 ? Math.max(...vals) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);

  // Reference line at starting price (first value)
  const refPrice = vals.length > 0 ? vals[0] : data.previousClose;
  const refY = chartT + (1 - (refPrice - sparkMin) / sparkRange) * chartH;

  const sparkPoints = vals.length > 1
    ? vals.map((value, i) => {
      const t = i / (vals.length - 1);
      const x = chartL + t * chartW;
      const y = chartT + (1 - (value - sparkMin) / sparkRange) * chartH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : `${chartL},${chartB} ${chartR},${chartB}`;

  const fillPoints = `${chartL},${chartB} ${sparkPoints} ${chartR},${chartB}`;

  // Date labels along the bottom of the chart (pick ~5 evenly spaced)
  const dateLabels: string[] = [];
  if (data.sparklineDates.length > 0) {
    const step = Math.max(1, Math.floor(data.sparklineDates.length / 5));
    for (let i = 0; i < data.sparklineDates.length; i += step) {
      const label = data.sparklineDates[i];
      if (label) {
        const x = chartL + (i / Math.max(1, data.sparklineDates.length - 1)) * chartW;
        dateLabels.push(`<text x="${x.toFixed(0)}" y="${chartB + 24}" fill="#444" font-size="12" font-weight="400" font-family="${F}" text-anchor="middle">${escapeXml(label)}</text>`);
      }
    }
  }

  const logoEl = _LOGO_B64
    ? `<image x="48" y="${H - 64}" width="32" height="32" href="data:image/png;base64,${_LOGO_B64}"/>`
    : '';

  const stockUrl = `https://nalaai.com/market/${encodeURIComponent(data.ticker)}`;
  const qrSize = 44;
  const qrX = W - 44 - qrSize;
  const qrY = H - 62;
  const qrSvg = await generateQrSvgGroup(stockUrl, qrX, qrY, qrSize);

  // Exchange abbreviation
  const exchangeText = data.exchange ? escapeXml(data.exchange.toUpperCase()) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="chartClip">
      <rect x="${chartL}" y="${chartT}" width="${chartW}" height="${chartH}"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#000000"/>

  <!-- Company logo — glassmorphic box -->
  <rect x="48" y="28" width="48" height="48" rx="12" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  ${data.logoB64 ? `<image x="54" y="34" width="36" height="36" href="${data.logoB64}" preserveAspectRatio="xMidYMid meet"/>` : `<text x="72" y="60" fill="#666" font-size="16" font-weight="700" text-anchor="middle" font-family="${F}">${escapeXml(data.ticker.slice(0, 2))}</text>`}

  <!-- Company name + ticker row -->
  <text x="110" y="54" fill="white" font-size="26" font-weight="700" font-family="${F}">${escapeXml(data.companyName)}</text>
  <text x="110" y="78" fill="#666" font-size="14" font-weight="500" font-family="${F}">${escapeXml(data.ticker)}${exchangeText ? `  ·  ${exchangeText}` : ''}</text>

  <!-- Price — large, prominent -->
  <text x="52" y="160" fill="white" font-size="64" font-weight="700" font-family="${F}">${priceText}</text>

  <!-- Change + period label -->
  <text x="54" y="198" fill="${accent}" font-size="22" font-weight="600" font-family="${F}">${changeValText}  ${changePctText}</text>
  <text x="${54 + (changeValText.length + changePctText.length + 2) * 11.5}" y="198" fill="#666" font-size="18" font-weight="400" font-family="${F}">${escapeXml(data.periodLabel)}</text>

  <!-- Market status badge -->
  <rect x="52" y="212" width="${data.marketStatus.length * 9 + 20}" height="24" rx="4" fill="${data.marketStatus === 'OPEN' ? 'rgba(0,200,5,0.08)' : 'rgba(251,146,60,0.08)'}" stroke="${data.marketStatus === 'OPEN' ? 'rgba(0,200,5,0.15)' : 'rgba(251,146,60,0.15)'}" stroke-width="1"/>
  <text x="62" y="229" fill="${data.marketStatus === 'OPEN' ? '#4ade80' : '#fb923c'}" font-size="11" font-weight="600" letter-spacing="0.8" font-family="${F}">${data.marketStatus}</text>

  <!-- Chart (clipped to chart area) -->
  <g clip-path="url(#chartClip)">
    <line x1="${chartL}" y1="${refY.toFixed(1)}" x2="${chartR}" y2="${refY.toFixed(1)}" stroke="${accent}" stroke-width="1" stroke-dasharray="6,4" opacity="0.3"/>
    <polygon points="${fillPoints}" fill="${accent}" opacity="0.06"/>
    <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="1.8" opacity="0.85" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Date labels -->
  ${dateLabels.join('\n  ')}

  <!-- Footer area -->
  ${_LOGO_TRANSPARENT_B64 ? `<image x="44" y="${H - 56}" width="40" height="40" href="data:image/png;base64,${_LOGO_TRANSPARENT_B64}"/>` : ''}
  <text x="88" y="${H - 38}" fill="white" font-size="16" font-weight="700" font-family="${F}">NalaAI.com</text>
  <text x="88" y="${H - 20}" fill="#555" font-size="11" font-family="${F}">Portfolio Intelligence Platform</text>
  <text x="${qrX - 10}" y="${H - 34}" fill="#444" font-size="10" text-anchor="end" font-family="${F}">Scan to view</text>
  ${qrSvg}
</svg>`;
}

async function buildPerformanceSvg(data: PerformanceShareCardData): Promise<string> {
  const W = 1200;
  const H = 630;
  const GREEN = '#00c805';
  const RED = '#e8544e';
  const F = 'Inter, sans-serif';
  const positive = data.periodChangePercent >= 0;
  const accent = positive ? GREEN : RED;
  const changePctText = `(${positive ? '+' : ''}${data.periodChangePercent.toFixed(2)}%)`;
  const changeValueText = `${positive ? '+' : ''}$${Math.abs(data.periodChangeValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const currentValueText = `$${data.currentValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const periodLabel = data.periodLabel;

  // Chart area — generous, matching stock card proportions
  const chartL = 48;
  const chartR = W - 48;
  const chartT = 260;
  const chartB = 490;
  const chartW = chartR - chartL;
  const chartH = chartB - chartT;

  const vals = data.sparklineValues;
  const sparkMin = vals.length > 0 ? Math.min(...vals) : 0;
  const sparkMax = vals.length > 0 ? Math.max(...vals) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);

  // Reference line at periodStartValue (previous close for 1D, start-of-period for others)
  // Include periodStartValue in min/max so the baseline is always visible on the chart
  const refPrice = data.periodStartValue;
  const allVals = [...vals, refPrice];
  const adjMin = Math.min(...allVals);
  const adjMax = Math.max(...allVals);
  const adjRange = Math.max(1e-6, adjMax - adjMin);
  const refY = chartT + (1 - (refPrice - adjMin) / adjRange) * chartH;

  const sparkPoints = vals.length > 1
    ? vals.map((value, i) => {
      const t = i / (vals.length - 1);
      const x = chartL + t * chartW;
      const y = chartT + (1 - (value - adjMin) / adjRange) * chartH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : `${chartL},${chartB} ${chartR},${chartB}`;

  const fillPoints = `${chartL},${chartB} ${sparkPoints} ${chartR},${chartB}`;

  // Date labels along the bottom of the chart (pick ~5 evenly spaced)
  const dateLabels: string[] = [];
  if (data.sparklineDates.length > 0) {
    const step = Math.max(1, Math.floor(data.sparklineDates.length / 5));
    for (let i = 0; i < data.sparklineDates.length; i += step) {
      const label = data.sparklineDates[i];
      if (label) {
        const x = chartL + (i / Math.max(1, data.sparklineDates.length - 1)) * chartW;
        dateLabels.push(`<text x="${x.toFixed(0)}" y="${chartB + 24}" fill="#444" font-size="12" font-weight="400" font-family="${F}" text-anchor="middle">${escapeXml(label)}</text>`);
      }
    }
  }

  // Footer
  const profileUrl = `https://nalaai.com/${encodeURIComponent(data.username)}`;
  const qrSize = 44;
  const qrX = W - 44 - qrSize;
  const qrY = H - 62;
  const qrSvg = await generateQrSvgGroup(profileUrl, qrX, qrY, qrSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="chartClipP">
      <rect x="${chartL}" y="${chartT}" width="${chartW}" height="${chartH}"/>
    </clipPath>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#000000"/>

  <!-- Avatar glassmorphic box with initials -->
  <rect x="48" y="28" width="48" height="48" rx="12" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="72" y="60" fill="${accent}" font-size="18" font-weight="700" text-anchor="middle" font-family="${F}">${escapeXml(data.displayName.slice(0, 2).toUpperCase())}</text>

  <!-- Display name + @username -->
  <text x="110" y="54" fill="#ddd" font-size="22" font-weight="600" font-family="${F}">${escapeXml(data.displayName)}</text>
  <text x="110" y="76" fill="#666" font-size="13" font-weight="500" font-family="${F}">@${escapeXml(data.username)}</text>
  <text x="${W - 50}" y="54" fill="#555" font-size="16" font-weight="500" text-anchor="end" font-family="${F}">Portfolio</text>

  <!-- Portfolio value — large, prominent -->
  <text x="52" y="160" fill="white" font-size="64" font-weight="700" font-family="${F}">${currentValueText}</text>

  <!-- Change + period label -->
  <text x="54" y="198" fill="${accent}" font-size="22" font-weight="600" font-family="${F}">${changeValueText}  ${changePctText}</text>
  <text x="${54 + (changeValueText.length + changePctText.length + 2) * 11.5}" y="198" fill="#666" font-size="18" font-weight="400" font-family="${F}">${escapeXml(periodLabel)}</text>

  <!-- Chart (clipped to chart area) -->
  <g clip-path="url(#chartClipP)">
    <line x1="${chartL}" y1="${refY.toFixed(1)}" x2="${chartR}" y2="${refY.toFixed(1)}" stroke="${accent}" stroke-width="1" stroke-dasharray="6,4" opacity="0.5"/>
    <polygon points="${fillPoints}" fill="${accent}" opacity="0.06"/>
    <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="1.8" opacity="0.85" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- Date labels -->
  ${dateLabels.join('\n  ')}

  <!-- Footer area -->
  ${_LOGO_TRANSPARENT_B64 ? `<image x="44" y="${H - 56}" width="40" height="40" href="data:image/png;base64,${_LOGO_TRANSPARENT_B64}"/>` : ''}
  <text x="88" y="${H - 38}" fill="white" font-size="16" font-weight="700" font-family="${F}">NalaAI.com</text>
  <text x="88" y="${H - 20}" fill="#555" font-size="11" font-family="${F}">Portfolio Intelligence Platform</text>
  <text x="${qrX - 10}" y="${H - 34}" fill="#444" font-size="10" text-anchor="end" font-family="${F}">Scan to view</text>
  ${qrSvg}
</svg>`;
}

export async function generateStockShareCard(ticker: string, period?: string): Promise<Buffer | null> {
  const data = await getStockShareCardData(ticker, period);
  if (!data) return null;

  const svg = await buildStockSvg(data);
  return sharp(Buffer.from(svg))
    .resize(1200, 630)
    .png({ quality: 90 })
    .toBuffer();
}

export async function generatePerformanceCard(userId: string, period: string): Promise<Buffer | null> {
  const data = await getPerformanceShareCardData(userId, period);
  if (!data) return null;

  const svg = await buildPerformanceSvg(data);
  return sharp(Buffer.from(svg))
    .resize(1200, 630)
    .png({ quality: 90 })
    .toBuffer();
}
