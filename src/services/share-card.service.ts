import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import prisma from '../utils/prisma';
import { getPerformanceComparison } from './benchmark.service';
import { getLeaderboard } from './leaderboard.service';
import { getUserChartSnapshots } from './snapshot.service';
import { fetchHourlyCandles, fetchStockDetails } from './market.service';

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

interface ShareCardData {
  username: string;
  displayName: string;
  returnPct: number | null;
  alphaPct: number | null;
  benchmarkReturnPct: number | null;
  beta: number | null;
  leaderboardRank: number | null;
  leaderboardTotal: number | null;
  nalaScore: number | null;
  followerCount: number;
  isCreator: boolean;
  sparklineValues: number[];
  portfolioValue: number | null;
  periodChangeValue: number | null;
}

function getEmotionalTagline(returnPct: number | null): string {
  if (returnPct == null) return '';
  if (returnPct >= 15) return 'On fire';
  if (returnPct >= 8) return 'Crushing it';
  if (returnPct >= 3) return 'Solid month';
  if (returnPct >= 0) return 'Steady gains';
  if (returnPct >= -3) return 'Not my best month';
  if (returnPct >= -8) return 'Rough patch';
  return 'Pain.';
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

async function getShareCardData(userId: string): Promise<ShareCardData | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      profilePublic: true,
      creator: { select: { status: true } },
    },
  });

  if (!user || !user.profilePublic) return null;

  // Trade delay: if creator has active delay, use longer-term data only.
  // Performance metrics derived from current holdings would reveal recent trades.
  const delayed = await hasActiveTradeDelay(userId);

  const [performance, leaderboard, followerCount, chart] = await Promise.all([
    delayed ? Promise.resolve(null) : getPerformanceComparison('1M', 'SPY', userId).catch(() => null),
    getLeaderboard('1M', 'world').catch(() => null),
    prisma.follow.count({ where: { followingId: userId } }),
    getUserChartSnapshots(userId, '1M').catch(() => null),
  ]);

  let leaderboardRank: number | null = null;
  let leaderboardTotal: number | null = null;
  let nalaScore: number | null = null;
  if (leaderboard?.entries) {
    leaderboardTotal = leaderboard.entries.length;
    const idx = leaderboard.entries.findIndex((e: { userId: string }) => e.userId === userId);
    if (idx >= 0) {
      leaderboardRank = idx + 1;
    }
  }

  if (performance) {
    const ret = performance.twrPct ?? performance.simpleReturnPct ?? 0;
    const alpha = performance.alphaPct ?? 0;
    const vol = performance.volatilityPct ?? 20;
    const raw = Math.min(100, Math.max(0, 50 + (ret * 1.5) + (alpha * 2) - (vol * 0.5)));
    nalaScore = Math.round(raw);
  }

  // Trade delay: filter out recent snapshots for delayed creators
  let rawValues = (chart?.points ?? [])
    .map((p: { value: number; time?: number }) => p)
    .filter((p) => Number.isFinite(p.value) && p.value > 0);

  if (delayed && rawValues.length > 0) {
    // Get the delay hours to filter out recent snapshots
    const creator = await prisma.creator.findUnique({
      where: { userId },
      select: { visibility: { select: { tradeDelayHours: true } } },
    });
    const delayCutoff = Date.now() - (creator?.visibility?.tradeDelayHours ?? 24) * 60 * 60 * 1000;
    rawValues = rawValues.filter(p => !p.time || p.time <= delayCutoff);
  }

  const sparkValues = rawValues.map(p => p.value);
  const targetSparkCount = 48;
  let sparklineValues: number[] = [];
  if (sparkValues.length > 0) {
    if (sparkValues.length <= targetSparkCount) {
      sparklineValues = sparkValues;
    } else {
      const step = (sparkValues.length - 1) / (targetSparkCount - 1);
      sparklineValues = Array.from({ length: targetSparkCount }, (_, i) => {
        const idx = Math.round(i * step);
        return sparkValues[idx];
      });
    }
  }

  // Use simple return for share cards — TWR can be misleading when
  // selling holdings creates auto-withdrawal transactions that inflate TWR.
  const userReturn = performance?.simpleReturnPct ?? performance?.twrPct ?? null;
  const userAlpha = performance?.alphaPct ?? null;
  const currentValue = sparkValues.length > 0 ? sparkValues[sparkValues.length - 1] : null;
  const psvRaw = chart?.periodStartValue ?? 0;
  const startValue = psvRaw > 0 ? psvRaw : (sparkValues.length > 0 ? sparkValues[0] : null);
  const periodChangeValue = currentValue != null && startValue != null ? currentValue - startValue : null;

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    returnPct: userReturn,
    alphaPct: userAlpha,
    benchmarkReturnPct: userReturn != null && userAlpha != null ? userReturn - userAlpha : null,
    beta: performance?.beta ?? null,
    leaderboardRank,
    leaderboardTotal,
    nalaScore,
    followerCount,
    isCreator: user.creator?.status === 'active',
    sparklineValues,
    portfolioValue: currentValue,
    periodChangeValue,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getGrade(score: number | null): { letter: string; color: string } {
  if (score == null) return { letter: '--', color: '#6B7280' };
  if (score >= 90) return { letter: 'A+', color: '#00c805' };
  if (score >= 80) return { letter: 'A', color: '#00c805' };
  if (score >= 70) return { letter: 'B+', color: '#3B82F6' };
  if (score >= 60) return { letter: 'B', color: '#3B82F6' };
  if (score >= 50) return { letter: 'C', color: '#eab308' };
  return { letter: 'F', color: '#e8544e' };
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

async function buildSvg(data: ShareCardData): Promise<string> {
  const W = 1200;
  const H = 630;
  const GREEN = '#00c805';
  const GREEN_BRIGHT = '#00ff88';
  const RED = '#FF4D4D';
  const RED_DARK = '#B91C1C';
  const F = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';

  const isPositive = data.returnPct != null ? data.returnPct >= 0 : true;
  const accent = isPositive ? GREEN : RED;
  const accentEnd = isPositive ? GREEN_BRIGHT : RED_DARK;
  const retText = data.returnPct != null
    ? `${data.returnPct >= 0 ? '+' : ''}${data.returnPct.toFixed(1)}%`
    : '--';

  const tagline = getEmotionalTagline(data.returnPct);
  const grade = getGrade(data.nalaScore);

  const alphaText = data.alphaPct != null ? `${data.alphaPct >= 0 ? '+' : ''}${data.alphaPct.toFixed(1)}%` : '--';
  const alphaColor = data.alphaPct != null ? (data.alphaPct >= 0 ? GREEN : RED) : '#666';
  const benchText = data.benchmarkReturnPct != null ? `${data.benchmarkReturnPct >= 0 ? '+' : ''}${data.benchmarkReturnPct.toFixed(1)}%` : '--';
  const valueText = data.portfolioValue != null ? `$${Math.round(data.portfolioValue).toLocaleString('en-US')}` : '--';
  const changeText = data.periodChangeValue != null
    ? `${data.periodChangeValue >= 0 ? '+' : '-'}$${Math.abs(data.periodChangeValue).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    : '--';
  const changeColor = data.periodChangeValue != null ? (data.periodChangeValue >= 0 ? GREEN : RED) : '#666';

  // Chart — full width strip
  const sparkL = 50;
  const sparkR = W - 50;
  const sparkT = 340;
  const sparkB = 430;
  const sparkW = sparkR - sparkL;
  const sparkHt = sparkB - sparkT;
  const sparkMin = data.sparklineValues.length > 0 ? Math.min(...data.sparklineValues) : 0;
  const sparkMax = data.sparklineValues.length > 0 ? Math.max(...data.sparklineValues) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);
  const sparkPoints = data.sparklineValues.length > 1
    ? data.sparklineValues.map((value, i) => {
      const t = i / (data.sparklineValues.length - 1);
      const x = sparkL + t * sparkW;
      const y = sparkT + (1 - (value - sparkMin) / sparkRange) * sparkHt;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : `${sparkL},${sparkB} ${sparkR},${sparkB}`;
  const fillPoints = `${sparkL},${sparkB} ${sparkPoints} ${sparkR},${sparkB}`;

  const logoEl = _LOGO_B64
    ? `<image x="48" y="${H - 66}" width="34" height="34" href="data:image/png;base64,${_LOGO_B64}"/>`
    : '';

  const referralUrl = `https://nalaai.com/join?ref=${encodeURIComponent(data.username)}`;
  const qrSize = 48;
  const qrX = W - 44 - qrSize;
  const qrY = H - 68;
  const qrSvg = await generateQrSvgGroup(referralUrl, qrX, qrY, qrSize);

  // Glass tiles
  const tileW = 130;
  const tileH = 52;
  const tileY = 445;
  const tileGap = 12;
  const tiles = [
    { label: 'ALPHA', value: alphaText, color: alphaColor },
    { label: 'SCORE', value: `${data.nalaScore ?? '--'} ${grade.letter}`, color: grade.color },
    { label: 'RANK', value: data.leaderboardRank != null ? `#${data.leaderboardRank}` : '--', color: 'white' },
    { label: 'FOLLOWERS', value: `${data.followerCount}`, color: 'white' },
  ];
  const tilesStartX = 50;
  const tilesSvg = tiles.map((t, i) => {
    const tx = tilesStartX + i * (tileW + tileGap);
    return `
      <rect x="${tx}" y="${tileY}" width="${tileW}" height="${tileH}" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${tx + 14}" y="${tileY + 18}" fill="#777" font-size="9" font-weight="600" letter-spacing="1.2" font-family="${F}">${t.label}</text>
      <text x="${tx + 14}" y="${tileY + 40}" fill="${t.color}" font-size="18" font-weight="700" font-family="${F}">${t.value}</text>
    `;
  }).join('');

  // SPY comparison tile (wider)
  const spyTileX = tilesStartX + 4 * (tileW + tileGap);
  const spyTileW = W - 50 - spyTileX;
  const spySvg = `
    <rect x="${spyTileX}" y="${tileY}" width="${spyTileW}" height="${tileH}" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    <text x="${spyTileX + 14}" y="${tileY + 18}" fill="#777" font-size="9" font-weight="600" letter-spacing="1.2" font-family="${F}">VS SPY</text>
    <text x="${spyTileX + 14}" y="${tileY + 40}" fill="white" font-size="14" font-weight="600" font-family="${F}">You ${retText}</text>
    <text x="${spyTileX + 130}" y="${tileY + 40}" fill="#777" font-size="14" font-weight="600" font-family="${F}">SPY ${benchText}</text>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="accentBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${accentEnd}"/>
    </linearGradient>
    <linearGradient id="heroGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${accentEnd}"/>
    </linearGradient>
    <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.30"/>
      <stop offset="50%" stop-color="${accent}" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="chartGlow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#0e0e11"/>

  <!-- Gradient accent bar -->
  <rect width="${W}" height="4" fill="url(#accentBar)"/>

  <!-- Identity -->
  <text x="50" y="52" fill="white" font-size="28" font-weight="700" font-family="${F}">${escapeXml(data.displayName)}</text>
  <text x="${W - 50}" y="52" fill="#555" font-size="16" font-weight="500" text-anchor="end" font-family="${F}">${data.isCreator ? 'Creator Portfolio' : 'Portfolio'}</text>

  <!-- Label -->
  <text x="50" y="100" fill="#666" font-size="13" font-weight="600" letter-spacing="2" font-family="${F}">MONTHLY PERFORMANCE</text>

  <!-- Hero return with glow -->
  <text x="46" y="220" fill="url(#heroGrad)" font-size="140" font-weight="700" font-family="${F}" filter="url(#glow)">${retText}</text>

  <!-- Emotional tagline -->
  <text x="52" y="252" fill="#888" font-size="18" font-weight="400" font-style="italic" font-family="${F}">${escapeXml(tagline)}</text>

  <!-- Portfolio value + change -->
  <text x="52" y="295" fill="white" font-size="20" font-weight="600" font-family="${F}">${valueText}</text>
  <text x="52" y="318" fill="${changeColor}" font-size="16" font-weight="500" font-family="${F}">${changeText} this month</text>

  <!-- Chart with glow -->
  <polygon points="${fillPoints}" fill="url(#chartFill)"/>
  <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="3" opacity="0.8" stroke-linecap="round" stroke-linejoin="round" filter="url(#chartGlow)"/>

  <!-- Glass tiles -->
  ${tilesSvg}
  ${spySvg}

  <!-- Footer -->
  <rect x="0" y="${H - 76}" width="${W}" height="76" fill="#0a0a0c"/>
  <rect x="0" y="${H - 76}" width="${W}" height="1" fill="#222"/>
  ${logoEl}
  <text x="90" y="${H - 42}" fill="white" font-size="17" font-weight="700" font-family="${F}">NalaAI.com</text>
  <text x="90" y="${H - 24}" fill="#555" font-size="11" font-family="${F}">Track creator portfolios</text>
  <text x="${qrX - 12}" y="${H - 36}" fill="#555" font-size="11" text-anchor="end" font-family="${F}">Scan to follow</text>
  ${qrSvg}
</svg>`;
}

export async function generateShareCard(userId: string): Promise<Buffer | null> {
  const data = await getShareCardData(userId);
  if (!data) return null;

  const svg = await buildSvg(data);
  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(1200, 630)
    .png({ quality: 90 })
    .toBuffer();

  return pngBuffer;
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
  currentValue: number;
  periodChangeValue: number;
  periodChangePercent: number;
  sparklineValues: number[];
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

async function getStockShareCardData(inputTicker: string, periodInput?: string): Promise<StockShareCardData | null> {
  const ticker = inputTicker.toUpperCase();
  const period = normalizePeriod(periodInput || '1W');
  const [details, candles] = await Promise.all([
    fetchStockDetails(ticker).catch(() => null),
    (['1W', '1M', '6M', 'YTD'].includes(period) ? fetchHourlyCandles(ticker, period as '1W' | '1M' | '6M' | 'YTD') : Promise.resolve([])).catch(() => []),
  ]);

  if (!details?.quote) return null;

  const currentPrice = details.quote.extendedPrice && details.quote.extendedPrice > 0
    ? details.quote.extendedPrice
    : details.quote.currentPrice;

  // Build sparkline from candles or daily closes
  const candleValues = candles
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

  const changeValue = currentPrice - startPrice;
  const changePercent = startPrice > 0 ? (changeValue / startPrice) * 100 : 0;

  // Use hourly candles if available, otherwise daily
  const rawValues = candleValues.length > 0 ? candleValues : (filteredCloses.length > 0 ? filteredCloses : [currentPrice, currentPrice]);
  const sparklineValues = downsampleValues(rawValues, 128);

  // Build date labels for the chart
  const rawDates = candleValues.length > 0
    ? candles.filter(c => Number.isFinite(c.close) && c.close > 0).map(c => c.time)
    : (filteredDates.length > 0 ? filteredDates : []);
  const sparklineDates = downsampleValues(
    rawDates.length > 0 ? rawDates.map((_, i) => i) : [0, 1],
    64,
  ).map(idx => {
    const d = rawDates[Math.round(idx)];
    if (!d) return '';
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Market status
  const hour = now.getUTCHours() - 5; // EST approximation
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  const isPreMarket = hour >= 4 && hour < 9.5;
  const isAfterHours = hour >= 16 && hour < 20;
  const isMarketOpen = !isWeekend && hour >= 9.5 && hour < 16;
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
    },
  });

  if (!user || !user.profilePublic) return null;

  // Trade delay: filter out recent snapshots so chart doesn't reveal trade timing
  const delayed = await hasActiveTradeDelay(userId);
  let delayCutoff = 0;
  if (delayed) {
    const creator = await prisma.creator.findUnique({
      where: { userId },
      select: { visibility: { select: { tradeDelayHours: true } } },
    });
    delayCutoff = Date.now() - (creator?.visibility?.tradeDelayHours ?? 24) * 60 * 60 * 1000;
  }

  const period = normalizePeriod(periodInput);
  const chart = await getUserChartSnapshots(userId, period).catch(() => ({ points: [], periodStartValue: 0, period }));
  let values = chart.points
    .map((p: { value: number; time?: number }) => p)
    .filter((p) => Number.isFinite(p.value) && p.value > 0);

  // Remove snapshots within the delay window
  if (delayed && delayCutoff > 0) {
    values = values.filter(p => !p.time || p.time <= delayCutoff);
  }

  const numValues = values.map(p => p.value);

  const currentValue = numValues.length > 0 ? numValues[numValues.length - 1] : 0;
  const fallbackStart = numValues.length > 0 ? numValues[0] : currentValue;
  const periodStartValue = chart.periodStartValue > 0 ? chart.periodStartValue : fallbackStart;
  const periodChangeValue = currentValue - periodStartValue;
  const periodChangePercent = periodStartValue > 0 ? (periodChangeValue / periodStartValue) * 100 : 0;
  const sparklineValues = downsampleValues(numValues.length > 0 ? numValues : [currentValue, currentValue], 64);

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    period,
    currentValue,
    periodChangeValue,
    periodChangePercent,
    sparklineValues,
  };
}

async function buildStockSvg(data: StockShareCardData): Promise<string> {
  const W = 1200;
  const H = 630;
  const GREEN = '#00c805';
  const RED = '#e8544e';
  const F = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
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
  const F = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  const positive = data.periodChangePercent >= 0;
  const accent = positive ? GREEN : RED;
  const verb = positive ? 'up' : 'down';
  const changePctText = `${positive ? '+' : ''}${data.periodChangePercent.toFixed(2)}%`;
  const changeValueText = `${positive ? '+' : '-'}$${Math.abs(data.periodChangeValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const currentValueText = `$${data.currentValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  const periodLabels: Record<string, string> = {
    '1D': 'today', '1W': 'this week', '1M': 'this month',
    '3M': 'in 3 months', '6M': 'in 6 months', 'YTD': 'this year', '1Y': 'in a year', 'ALL': 'all time',
  };
  const periodLabel = periodLabels[data.period] || data.period;

  // Sparkline — subtle strip across bottom, above footer
  const sparkL = 60;
  const sparkR = W - 60;
  const sparkT = 440;
  const sparkB = 530;
  const sparkW = sparkR - sparkL;
  const sparkH_val = sparkB - sparkT;
  const sparkMin = data.sparklineValues.length > 0 ? Math.min(...data.sparklineValues) : 0;
  const sparkMax = data.sparklineValues.length > 0 ? Math.max(...data.sparklineValues) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);
  const sparkPoints = data.sparklineValues.length > 1
    ? data.sparklineValues.map((value, i) => {
      const t = i / (data.sparklineValues.length - 1);
      const x = sparkL + t * sparkW;
      const y = sparkT + (1 - (value - sparkMin) / sparkRange) * sparkH_val;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : `${sparkL},${sparkB} ${sparkR},${sparkB}`;
  const fillPoints = `${sparkL},${sparkB} ${sparkPoints} ${sparkR},${sparkB}`;

  const logoEl = _LOGO_B64
    ? `<image x="48" y="${H - 68}" width="36" height="36" href="data:image/png;base64,${_LOGO_B64}"/>`
    : '';

  const profileUrl = `https://nalaai.com/${encodeURIComponent(data.username)}`;
  const qrSize = 50;
  const qrX = W - 48 - qrSize;
  const qrY = H - 70;
  const qrSvg = await generateQrSvgGroup(profileUrl, qrX, qrY, qrSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sparkFillP" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#111114"/>
  <rect width="${W}" height="4" fill="${accent}"/>

  <!-- Username -->
  <text x="60" y="68" fill="#777" font-size="18" font-weight="400" font-family="${F}">@${escapeXml(data.username)}</text>

  <!-- Hero statement -->
  <text x="60" y="130" fill="white" font-size="40" font-weight="700" font-family="${F}">My portfolio is ${verb}</text>

  <!-- Hero percent -->
  <text x="56" y="240" fill="${accent}" font-size="100" font-weight="700" font-family="${F}">${changePctText}</text>

  <!-- Period label -->
  <text x="62" y="278" fill="#888" font-size="20" font-weight="400" font-family="${F}">${periodLabel}</text>

  <!-- Value stats -->
  <text x="60" y="350" fill="${accent}" font-size="28" font-weight="600" font-family="${F}">${changeValueText}</text>
  <text x="60" y="400" fill="white" font-size="36" font-weight="700" font-family="${F}">${currentValueText}</text>
  <text x="62" y="428" fill="#666" font-size="14" font-weight="400" font-family="${F}">portfolio value</text>

  <!-- Sparkline — subtle strip above footer -->
  <polygon points="${fillPoints}" fill="url(#sparkFillP)"/>
  <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="2" opacity="0.5" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Bottom bar -->
  <rect x="0" y="${H - 80}" width="${W}" height="80" fill="#0a0a0c"/>
  <rect x="0" y="${H - 80}" width="${W}" height="1" fill="#222"/>
  ${logoEl}
  <text x="92" y="${H - 42}" fill="white" font-size="18" font-weight="700" font-family="${F}">NalaAI.com</text>
  <text x="92" y="${H - 22}" fill="#666" font-size="12" font-family="${F}">Portfolio Intelligence Platform</text>
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
