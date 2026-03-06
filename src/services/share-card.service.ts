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
  beta: number | null;
  leaderboardRank: number | null;
  nalaScore: number | null;
  followerCount: number;
  isCreator: boolean;
  sparklineValues: number[];
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

  const [performance, leaderboard, followerCount, chart] = await Promise.all([
    getPerformanceComparison('1M', 'SPY', userId).catch(() => null),
    getLeaderboard('1M', 'world').catch(() => null),
    prisma.follow.count({ where: { followingId: userId } }),
    getUserChartSnapshots(userId, '1M').catch(() => null),
  ]);

  let leaderboardRank: number | null = null;
  let nalaScore: number | null = null;
  if (leaderboard?.entries) {
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

  const rawValues = (chart?.points ?? [])
    .map((p: { value: number }) => p.value)
    .filter((v: number) => Number.isFinite(v) && v > 0);
  const targetSparkCount = 36;
  let sparklineValues: number[] = [];
  if (rawValues.length > 0) {
    if (rawValues.length <= targetSparkCount) {
      sparklineValues = rawValues;
    } else {
      const step = (rawValues.length - 1) / (targetSparkCount - 1);
      sparklineValues = Array.from({ length: targetSparkCount }, (_, i) => {
        const idx = Math.round(i * step);
        return rawValues[idx];
      });
    }
  }

  return {
    username: user.username,
    displayName: user.displayName || user.username,
    returnPct: performance?.twrPct ?? performance?.simpleReturnPct ?? null,
    alphaPct: performance?.alphaPct ?? null,
    beta: performance?.beta ?? null,
    leaderboardRank,
    nalaScore,
    followerCount,
    isCreator: user.creator?.status === 'active',
    sparklineValues,
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
  const RED = '#e8544e';
  const CYAN = '#14b8a6';
  const F = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';

  const isPositive = data.returnPct != null ? data.returnPct >= 0 : true;
  const accentColor = isPositive ? GREEN : RED;
  const retText = data.returnPct != null
    ? `${data.returnPct >= 0 ? '+' : ''}${data.returnPct.toFixed(1)}%`
    : '--';

  const alphaText = data.alphaPct != null
    ? `${data.alphaPct >= 0 ? '+' : ''}${data.alphaPct.toFixed(1)}%`
    : '--';
  const alphaColor = data.alphaPct != null ? (data.alphaPct >= 0 ? GREEN : RED) : '#7f8894';

  const grade = getGrade(data.nalaScore);
  const rankText = data.leaderboardRank != null ? `#${data.leaderboardRank}` : '--';
  const heroHighlight = isPositive ? '#7CFF80' : '#FF9E96';

  const initials = data.displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  const logoEl = `<text x="60" y="${H - 34}" font-size="30" font-weight="800" font-family="${F}">
    <tspan fill="${GREEN}">N</tspan><tspan fill="#f3f4f6">ala</tspan>
  </text>`;

  const scoreR = 34;
  const scoreCirc = 2 * Math.PI * scoreR;
  const scoreDash = data.nalaScore != null ? (data.nalaScore / 100) * scoreCirc : 0;
  const scoreText = data.nalaScore != null ? `${data.nalaScore}` : '--';

  const glowR = isPositive ? '0,200,5' : '232,84,78';

  const sparkMin = data.sparklineValues.length > 0 ? Math.min(...data.sparklineValues) : 0;
  const sparkMax = data.sparklineValues.length > 0 ? Math.max(...data.sparklineValues) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);
  const sparkStartX = 95;
  const sparkEndX = 686;
  const sparkTopY = 422;
  const sparkBottomY = 516;
  const sparklinePoints = data.sparklineValues.length > 1
    ? data.sparklineValues.map((value, i) => {
      const t = i / (data.sparklineValues.length - 1);
      const x = sparkStartX + t * (sparkEndX - sparkStartX);
      const y = sparkBottomY - ((value - sparkMin) / sparkRange) * (sparkBottomY - sparkTopY);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : '95,500 686,440';

  // Generate QR code for referral link
  const referralUrl = `https://nalaai.com/join?ref=${encodeURIComponent(data.username)}`;
  const qrSize = 72;
  const qrX = W - 60 - qrSize;
  const qrY = H - 80;
  const qrSvg = await generateQrSvgGroup(referralUrl, qrX, qrY, qrSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="heroGlow" cx="0.28" cy="0.48" r="0.7" fx="0.28" fy="0.48">
      <stop offset="0%" stop-color="rgb(${glowR})" stop-opacity="0.18"/>
      <stop offset="55%" stop-color="rgb(${glowR})" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="rgb(${glowR})" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#06080b"/>
      <stop offset="100%" stop-color="#040506"/>
    </linearGradient>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#101418"/>
      <stop offset="100%" stop-color="#0b0f12"/>
    </linearGradient>
    <linearGradient id="topLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accentColor}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${CYAN}" stop-opacity="0.9"/>
    </linearGradient>
    <linearGradient id="gradeRing" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${grade.color}"/>
      <stop offset="100%" stop-color="${grade.color}" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="retFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${heroHighlight}"/>
      <stop offset="100%" stop-color="${accentColor}"/>
    </linearGradient>
    <filter id="numGlow">
      <feGaussianBlur stdDeviation="2.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="sparkClip"><rect x="84" y="414" width="612" height="112" rx="8"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="4" fill="url(#topLine)"/>
  <ellipse cx="370" cy="314" rx="420" ry="250" fill="url(#heroGlow)"/>

  <rect x="56" y="32" width="${W - 112}" height="${H - 124}" rx="22" fill="url(#panel)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

  <circle cx="106" cy="88" r="30" fill="rgba(${glowR}, 0.09)"/>
  <circle cx="106" cy="88" r="30" fill="none" stroke="url(#gradeRing)" stroke-width="2.4"/>
  <text x="106" y="97" fill="${accentColor}" font-size="17" font-weight="700" text-anchor="middle" font-family="${F}">${initials}</text>
  <circle cx="128" cy="108" r="12" fill="#0a0e10" stroke="${grade.color}" stroke-width="1.4"/>
  <text x="128" y="112.5" fill="${grade.color}" font-size="9.5" font-weight="800" text-anchor="middle" font-family="${F}">${grade.letter}</text>

  <text x="154" y="82" fill="#f3f4f6" font-size="32" font-weight="700" font-family="${F}">${escapeXml(data.displayName)}</text>
  <text x="154" y="110" fill="#88909b" font-size="15" font-family="${F}">@${escapeXml(data.username)}${data.isCreator ? '  -  Creator' : ''}</text>
  <rect x="56" y="136" width="${W - 112}" height="1" fill="rgba(255,255,255,0.08)"/>

  <text x="96" y="195" fill="#7f8894" font-size="14" font-weight="600" letter-spacing="2" font-family="${F}">1-MONTH RETURN</text>
  <text x="96" y="330" fill="url(#retFill)" font-size="108" font-weight="800" font-family="${F}" filter="url(#numGlow)">${retText}</text>
  <text x="96" y="372" fill="#7f8894" font-size="13" letter-spacing="1.5" font-family="${F}">BETA</text>
  <text x="96" y="404" fill="#e5e7eb" font-size="31" font-weight="700" font-family="${F}">${data.beta != null ? data.beta.toFixed(2) : '--'}</text>

  <rect x="84" y="414" width="612" height="112" rx="8" fill="rgba(8,12,15,0.7)" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <g clip-path="url(#sparkClip)">
    <polyline points="${sparklinePoints}"
      fill="none" stroke="${accentColor}" stroke-width="1.6" opacity="0.55" stroke-linecap="round"/>
    <polyline points="${sparklinePoints}"
      fill="none" stroke="${accentColor}" stroke-width="4" opacity="0.08" stroke-linecap="round"/>
  </g>

  <rect x="744" y="168" width="188" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="766" y="200" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">VS SPY (ALPHA)</text>
  <text x="766" y="250" fill="${alphaColor}" font-size="44" font-weight="800" font-family="${F}">${alphaText}</text>

  <rect x="952" y="168" width="188" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="974" y="200" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">FOLLOWERS</text>
  <text x="974" y="250" fill="#f3f4f6" font-size="48" font-weight="700" font-family="${F}">${data.followerCount}</text>

  <rect x="744" y="308" width="188" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="766" y="340" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">NALA SCORE</text>
  <circle cx="802" cy="381" r="${scoreR}" fill="none" stroke="${grade.color}" stroke-width="3" opacity="0.15"/>
  <circle cx="802" cy="381" r="${scoreR}" fill="none" stroke="${grade.color}" stroke-width="3"
    stroke-dasharray="${scoreDash} ${scoreCirc}" stroke-linecap="round" transform="rotate(-90 802 381)"/>
  <text x="802" y="389" fill="${grade.color}" font-size="25" font-weight="800" text-anchor="middle" font-family="${F}">${scoreText}</text>
  <text x="852" y="389" fill="#88909b" font-size="14" font-family="${F}">/ 100</text>

  <rect x="952" y="308" width="188" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="974" y="340" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">RANK</text>
  <text x="974" y="394" fill="${GREEN}" font-size="56" font-weight="800" font-family="${F}">${rankText}</text>

  <rect x="56" y="${H - 92}" width="${W - 112}" height="1" fill="rgba(255,255,255,0.08)"/>
  ${logoEl}
  <text x="60" y="${H - 19}" fill="#7f8894" font-size="10" font-family="${F}">Portfolio Intelligence Platform</text>
  <!-- QR code + label -->
  ${qrSvg}
  <text x="${qrX + qrSize / 2}" y="${qrY - 8}" fill="#7f8894" font-size="9" font-weight="600" text-anchor="middle" letter-spacing="1" font-family="${F}">SCAN TO JOIN</text>
  <text x="${W / 2}" y="${H - 8}" fill="#49505a" font-size="8" text-anchor="middle" font-family="${F}">Educational content only. Not investment advice. Past performance does not guarantee future results.</text>
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

  const period = normalizePeriod(periodInput);
  const chart = await getUserChartSnapshots(userId, period).catch(() => ({ points: [], periodStartValue: 0, period }));
  const values = chart.points
    .map((p: { value: number }) => p.value)
    .filter((v: number) => Number.isFinite(v) && v > 0);

  const currentValue = values.length > 0 ? values[values.length - 1] : 0;
  const fallbackStart = values.length > 0 ? values[0] : currentValue;
  const periodStartValue = chart.periodStartValue > 0 ? chart.periodStartValue : fallbackStart;
  const periodChangeValue = currentValue - periodStartValue;
  const periodChangePercent = periodStartValue > 0 ? (periodChangeValue / periodStartValue) * 100 : 0;
  const sparklineValues = downsampleValues(values.length > 0 ? values : [currentValue, currentValue], 64);

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
  const F = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
  const positive = data.dayChangePercent >= 0;
  const accent = positive ? GREEN : RED;
  const changeText = `${positive ? '+' : ''}${data.dayChangePercent.toFixed(2)}%`;

  const sparkMin = data.sparklineValues.length > 0 ? Math.min(...data.sparklineValues) : 0;
  const sparkMax = data.sparklineValues.length > 0 ? Math.max(...data.sparklineValues) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);
  const sparkStartX = 78;
  const sparkEndX = 1122;
  const sparkTopY = 300;
  const sparkBottomY = 520;
  const sparkPoints = data.sparklineValues.length > 1
    ? data.sparklineValues.map((value, i) => {
      const t = i / (data.sparklineValues.length - 1);
      const x = sparkStartX + t * (sparkEndX - sparkStartX);
      const y = sparkBottomY - ((value - sparkMin) / sparkRange) * (sparkBottomY - sparkTopY);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : `${sparkStartX},${sparkBottomY} ${sparkEndX},${sparkBottomY}`;

  const stockUrl = `https://nalaai.com/market/${encodeURIComponent(data.ticker)}`;
  const qrSize = 88;
  const qrX = W - 86 - qrSize;
  const qrY = 76;
  const qrSvg = await generateQrSvgGroup(stockUrl, qrX, qrY, qrSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#06080b"/>
      <stop offset="100%" stop-color="#030405"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#11c5a2" stop-opacity="0.8"/>
    </linearGradient>
    <clipPath id="sparkClipStock"><rect x="66" y="286" width="1068" height="248" rx="12"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="4" fill="url(#line)"/>
  <rect x="44" y="36" width="${W - 88}" height="${H - 72}" rx="24" fill="#0b1014" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

  <text x="88" y="132" fill="#f3f4f6" font-size="84" font-weight="800" font-family="${F}">${escapeXml(data.ticker)}</text>
  <text x="88" y="174" fill="#8d98a5" font-size="28" font-family="${F}">${escapeXml(data.companyName)}</text>
  <text x="88" y="254" fill="#f9fafb" font-size="72" font-weight="700" font-family="${F}">$${data.currentPrice.toFixed(2)}</text>
  <text x="470" y="254" fill="${accent}" font-size="50" font-weight="700" font-family="${F}">${changeText}</text>
  <text x="472" y="282" fill="#8d98a5" font-size="18" font-family="${F}">TODAY</text>

  <rect x="66" y="286" width="1068" height="248" rx="12" fill="rgba(9,13,16,0.9)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <g clip-path="url(#sparkClipStock)">
    <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.95" stroke-linecap="round"/>
    <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="8" opacity="0.10" stroke-linecap="round"/>
  </g>

  <text x="86" y="${H - 64}" fill="${GREEN}" font-size="34" font-weight="800" font-family="${F}">Nala</text>
  <text x="86" y="${H - 34}" fill="#8d98a5" font-size="14" font-family="${F}">Portfolio Intelligence Platform</text>
  ${qrSvg}
  <text x="${qrX + qrSize / 2}" y="${qrY + qrSize + 20}" fill="#8d98a5" font-size="10" text-anchor="middle" letter-spacing="1.2" font-family="${F}">OPEN IN NALA</text>
</svg>`;
}

async function buildPerformanceSvg(data: PerformanceShareCardData): Promise<string> {
  const W = 1200;
  const H = 630;
  const GREEN = '#00c805';
  const RED = '#e8544e';
  const F = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
  const positive = data.periodChangePercent >= 0;
  const accent = positive ? GREEN : RED;
  const verb = positive ? 'up' : 'down';
  const changePctText = `${positive ? '+' : ''}${data.periodChangePercent.toFixed(2)}%`;
  const changeValueText = `${positive ? '+' : '-'}$${Math.abs(data.periodChangeValue).toFixed(2)}`;

  const sparkMin = data.sparklineValues.length > 0 ? Math.min(...data.sparklineValues) : 0;
  const sparkMax = data.sparklineValues.length > 0 ? Math.max(...data.sparklineValues) : 0;
  const sparkRange = Math.max(1e-6, sparkMax - sparkMin);
  const sparkStartX = 84;
  const sparkEndX = 1116;
  const sparkTopY = 334;
  const sparkBottomY = 540;
  const sparkPoints = data.sparklineValues.length > 1
    ? data.sparklineValues.map((value, i) => {
      const t = i / (data.sparklineValues.length - 1);
      const x = sparkStartX + t * (sparkEndX - sparkStartX);
      const y = sparkBottomY - ((value - sparkMin) / sparkRange) * (sparkBottomY - sparkTopY);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ')
    : `${sparkStartX},${sparkBottomY} ${sparkEndX},${sparkBottomY}`;

  const profileUrl = `https://nalaai.com/${encodeURIComponent(data.username)}`;
  const qrSize = 88;
  const qrX = W - 90 - qrSize;
  const qrY = 70;
  const qrSvg = await generateQrSvgGroup(profileUrl, qrX, qrY, qrSize);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bgPerf" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#05080b"/>
      <stop offset="100%" stop-color="#030405"/>
    </linearGradient>
    <linearGradient id="linePerf" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#14b8a6" stop-opacity="0.9"/>
    </linearGradient>
    <clipPath id="sparkClipPerf"><rect x="72" y="320" width="1056" height="236" rx="12"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bgPerf)"/>
  <rect x="0" y="0" width="${W}" height="4" fill="url(#linePerf)"/>
  <rect x="44" y="36" width="${W - 88}" height="${H - 72}" rx="24" fill="#0b1014" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

  <text x="84" y="122" fill="#f3f4f6" font-size="42" font-weight="700" font-family="${F}">${escapeXml(data.displayName)}</text>
  <text x="84" y="180" fill="#f3f4f6" font-size="58" font-weight="700" font-family="${F}">My portfolio is ${verb} ${changePctText}</text>
  <text x="84" y="230" fill="#8d98a5" font-size="30" font-family="${F}">this ${data.period}</text>

  <text x="84" y="286" fill="${accent}" font-size="50" font-weight="700" font-family="${F}">${changeValueText}</text>
  <text x="320" y="286" fill="#f3f4f6" font-size="44" font-weight="700" font-family="${F}">$${data.currentValue.toFixed(2)}</text>
  <text x="322" y="310" fill="#8d98a5" font-size="16" font-family="${F}">CURRENT VALUE</text>

  <rect x="72" y="320" width="1056" height="236" rx="12" fill="rgba(9,13,16,0.9)" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <g clip-path="url(#sparkClipPerf)">
    <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="2.6" opacity="0.95" stroke-linecap="round"/>
    <polyline points="${sparkPoints}" fill="none" stroke="${accent}" stroke-width="8" opacity="0.1" stroke-linecap="round"/>
  </g>

  <text x="86" y="${H - 66}" fill="${GREEN}" font-size="34" font-weight="800" font-family="${F}">Nala</text>
  <text x="86" y="${H - 36}" fill="#8d98a5" font-size="14" font-family="${F}">Portfolio Intelligence Platform</text>
  ${qrSvg}
  <text x="${qrX + qrSize / 2}" y="${qrY + qrSize + 20}" fill="#8d98a5" font-size="10" text-anchor="middle" letter-spacing="1.2" font-family="${F}">VIEW PROFILE</text>
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
