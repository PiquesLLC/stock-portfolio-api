import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import prisma from '../utils/prisma';
import { reconstructPortfolioHistoryHiRes } from './snapshot.service';
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
  periodChangeValue: number;
  periodChangePercent: number;
  sparklineValues: number[];
  sparklineDates: string[];
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

  // Build sparkline from candles or daily closes — filter to market hours (weekday 4 AM–8 PM ET)
  const marketCandles = candles.filter(c => {
    const d = new Date(c.time);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    const etHour = d.getUTCHours() - 5;
    return etHour >= 4 && etHour < 20;
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

  const changeValue = currentPrice - startPrice;
  const changePercent = startPrice > 0 ? (changeValue / startPrice) * 100 : 0;

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

  // Use hi-res hourly candle reconstruction for a dynamic chart
  const [holdings, latestSnapshot, userSettings] = await Promise.all([
    prisma.holding.findMany({ where: { userId } }),
    prisma.portfolioSnapshot.findFirst({ where: { userId }, orderBy: { timestamp: 'desc' } }),
    prisma.userSettings.findUnique({ where: { userId } }),
  ]);

  const cashBalance = latestSnapshot?.cashBalance ?? 0;
  const marginDebt = userSettings?.marginDebt ?? 0;

  // Map period to Yahoo range/interval
  const rangeMap: Record<string, string> = {
    '1D': '1d',
    '1W': '5d',
    '1M': '1mo',
    '3M': '3mo',
    '6M': '6mo',
    'YTD': 'ytd',
    '1Y': '1y',
    'ALL': '5y',
  };
  const intervalMap: Record<string, string> = {
    '1D': '5m',
    '1W': '15m',
    '1M': '1h',
    '3M': '1h',
    '6M': '1h',
    'YTD': '1d',
    '1Y': '1d',
    'ALL': '1d',
  };

  let hiResPoints = holdings.length > 0
    ? await reconstructPortfolioHistoryHiRes(
        holdings.map(h => ({ ticker: h.ticker, shares: h.shares })),
        cashBalance,
        marginDebt,
        rangeMap[period] || '1mo',
        intervalMap[period] || '1h',
      ).catch(() => [] as { time: number; value: number }[])
    : [];

  // Remove points within the delay window
  if (delayed && delayCutoff > 0) {
    hiResPoints = hiResPoints.filter(p => p.time <= delayCutoff);
  }

  // Filter to market hours (weekday 4 AM–8 PM ET)
  const values = hiResPoints.filter(p => {
    if (!Number.isFinite(p.value) || p.value <= 0) return false;
    const d = new Date(p.time);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    const etHour = d.getUTCHours() - 5;
    return etHour >= 4 && etHour < 20;
  });

  const numValues = values.map(p => p.value);
  const numTimes = values.map(p => p.time);

  const currentValue = numValues.length > 0 ? numValues[numValues.length - 1] : 0;
  const startValue = numValues.length > 0 ? numValues[0] : currentValue;
  const periodChangeValue = currentValue - startValue;
  const periodChangePercent = startValue > 0 ? (periodChangeValue / startValue) * 100 : 0;
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
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  // Compute an accurate period label based on actual data range
  const idealLabels: Record<string, string> = {
    '1D': 'Today', '1W': 'Past Week', '1M': 'Past Month',
    '3M': 'Past 3 Months', '6M': 'Past 6 Months', 'YTD': 'Year to Date',
    '1Y': 'Past Year', 'ALL': 'All Time',
  };
  let periodLabel = idealLabels[period] || period;

  // If actual data range is shorter than the requested period, show real range
  if (numTimes.length >= 2) {
    const firstTime = numTimes[0];
    const lastTime = numTimes[numTimes.length - 1];
    const actualDays = Math.round((lastTime - firstTime) / (24 * 60 * 60 * 1000));
    const expectedDays: Record<string, number> = {
      '1D': 1, '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365,
    };
    const expected = expectedDays[period];
    // If data covers less than 70% of the requested period, show actual range
    if (expected && actualDays < expected * 0.7) {
      const startDate = new Date(firstTime);
      periodLabel = `Since ${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
  }

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    period,
    periodLabel,
    currentValue,
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
  const F = 'FreeSans, Liberation Sans, Arial, Helvetica, sans-serif';
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
  const F = 'FreeSans, Liberation Sans, Arial, Helvetica, sans-serif';
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

  // Reference line at starting price (first value)
  const refPrice = vals.length > 0 ? vals[0] : data.currentValue;
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
