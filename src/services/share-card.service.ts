import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import prisma from '../utils/prisma';
import { getPerformanceComparison } from './benchmark.service';
import { getLeaderboard } from './leaderboard.service';
import { getUserChartSnapshots } from './snapshot.service';
import { fetchHourlyCandles, fetchStockDetails } from './market.service';

// Load and cache logo as base64 at startup
let _LOGO_B64 = '';
try {
  const logoPath = path.join(__dirname, '..', '..', 'assets', 'north-signal-logo-80.png');
  if (fs.existsSync(logoPath)) {
    _LOGO_B64 = fs.readFileSync(logoPath).toString('base64');
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
  currentPrice: number;
  dayChangePercent: number;
  sparklineValues: number[];
}

type ShareCardPeriod = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

interface PerformanceShareCardData {
  username: string;
  displayName: string;
  period: ShareCardPeriod;
  currentValue: number;
  periodChangeValue: number;
  periodChangePercent: number;
  sparklineValues: number[];
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
  const valid: ShareCardPeriod[] = ['1D', '1W', '1M', '3M', 'YTD', '1Y', 'ALL'];
  return valid.includes(normalized) ? normalized : '1M';
}

async function getStockShareCardData(inputTicker: string): Promise<StockShareCardData | null> {
  const ticker = inputTicker.toUpperCase();
  const [details, candles] = await Promise.all([
    fetchStockDetails(ticker).catch(() => null),
    fetchHourlyCandles(ticker, '1M').catch(() => []),
  ]);

  if (!details?.quote) return null;

  const currentPrice = details.quote.extendedPrice && details.quote.extendedPrice > 0
    ? details.quote.extendedPrice
    : details.quote.currentPrice;

  const candleValues = candles
    .map(c => c.close)
    .filter(v => Number.isFinite(v) && v > 0);
  const fallbackValues = details.candles?.closes
    ?.slice(-48)
    .filter((v: number) => Number.isFinite(v) && v > 0) ?? [];
  const sparklineValues = downsampleValues(
    candleValues.length > 0 ? candleValues : (fallbackValues.length > 0 ? fallbackValues : [currentPrice, currentPrice]),
    48,
  );

  return {
    ticker,
    companyName: details.profile?.name || ticker,
    currentPrice,
    dayChangePercent: details.quote.changePercent ?? 0,
    sparklineValues,
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
  const positive = data.dayChangePercent >= 0;
  const accent = positive ? GREEN : RED;
  const changeText = `${positive ? '+' : ''}${data.dayChangePercent.toFixed(2)}%`;

  // Sparkline — bottom half
  const sparkL = 60;
  const sparkR = W - 60;
  const sparkT = 310;
  const sparkB = 460;
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

  const stockUrl = `https://nalaai.com/market/${encodeURIComponent(data.ticker)}`;
  const qrSize = 50;
  const qrX = W - 48 - qrSize;
  const qrY = H - 70;
  const qrSvg = await generateQrSvgGroup(stockUrl, qrX, qrY, qrSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sparkFillS" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#111114"/>
  <rect width="${W}" height="4" fill="${accent}"/>

  <!-- Ticker -->
  <text x="60" y="90" fill="white" font-size="60" font-weight="700" font-family="${F}">${escapeXml(data.ticker)}</text>
  <text x="62" y="120" fill="#777" font-size="18" font-weight="400" font-family="${F}">${escapeXml(data.companyName)}</text>

  <!-- Price -->
  <text x="60" y="210" fill="white" font-size="80" font-weight="700" font-family="${F}">$${data.currentPrice.toFixed(2)}</text>

  <!-- Change -->
  <text x="62" y="260" fill="${accent}" font-size="28" font-weight="600" font-family="${F}">${changeText} today</text>

  <!-- Sparkline -->
  <polygon points="${fillPoints}" fill="url(#sparkFillS)"/>
  <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.7" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- 1M label -->
  <text x="${W - 62}" y="${sparkB + 24}" fill="#666" font-size="12" font-weight="400" text-anchor="end" font-family="${F}">1 month</text>

  <!-- Bottom bar -->
  <rect x="0" y="${H - 80}" width="${W}" height="80" fill="#0a0a0c"/>
  <rect x="0" y="${H - 80}" width="${W}" height="1" fill="#222"/>
  ${logoEl}
  <text x="92" y="${H - 42}" fill="white" font-size="18" font-weight="700" font-family="${F}">NalaAI.com</text>
  <text x="92" y="${H - 22}" fill="#666" font-size="12" font-family="${F}">Portfolio Intelligence Platform</text>
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
    '3M': 'in 3 months', 'YTD': 'this year', '1Y': 'in a year', 'ALL': 'all time',
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

export async function generateStockShareCard(ticker: string): Promise<Buffer | null> {
  const data = await getStockShareCardData(ticker);
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
