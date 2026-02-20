import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import prisma from '../utils/prisma';
import { getPerformanceComparison } from './benchmark.service';
import { getLeaderboard } from './leaderboard.service';

// Load and cache logo as base64 at startup
let LOGO_B64 = '';
try {
  const logoPath = path.join(__dirname, '..', '..', 'assets', 'north-signal-logo-80.png');
  if (fs.existsSync(logoPath)) {
    LOGO_B64 = fs.readFileSync(logoPath).toString('base64');
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

  const [performance, leaderboard, followerCount] = await Promise.all([
    getPerformanceComparison('1M', 'SPY', userId).catch(() => null),
    getLeaderboard('1M', 'world').catch(() => null),
    prisma.follow.count({ where: { followingId: userId } }),
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

  const initials = data.displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  const logoEl = LOGO_B64
    ? `<image href="data:image/png;base64,${LOGO_B64}" x="60" y="${H - 58}" width="34" height="34"/>`
    : `<text x="77" y="${H - 33}" fill="${GREEN}" font-size="22" font-weight="800" text-anchor="middle" font-family="${F}">N</text>`;

  const scoreR = 34;
  const scoreCirc = 2 * Math.PI * scoreR;
  const scoreDash = data.nalaScore != null ? (data.nalaScore / 100) * scoreCirc : 0;
  const scoreText = data.nalaScore != null ? `${data.nalaScore}` : '--';

  const glowR = isPositive ? '0,200,5' : '232,84,78';

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
  <text x="96" y="330" fill="${accentColor}" font-size="112" font-weight="800" font-family="${F}" filter="url(#numGlow)">${retText}</text>
  <text x="96" y="372" fill="#7f8894" font-size="13" letter-spacing="1.5" font-family="${F}">BETA</text>
  <text x="96" y="404" fill="#e5e7eb" font-size="31" font-weight="700" font-family="${F}">${data.beta != null ? data.beta.toFixed(2) : '--'}</text>

  <rect x="84" y="414" width="612" height="112" rx="8" fill="rgba(8,12,15,0.7)" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  <g clip-path="url(#sparkClip)">
    <polyline points="95,508 168,500 242,503 316,484 390,474 464,468 538,448 612,457 686,420"
      fill="none" stroke="${accentColor}" stroke-width="1.6" opacity="0.55" stroke-linecap="round"/>
    <polyline points="95,508 168,500 242,503 316,484 390,474 464,468 538,448 612,457 686,420"
      fill="none" stroke="${accentColor}" stroke-width="4" opacity="0.08" stroke-linecap="round"/>
  </g>

  <rect x="748" y="168" width="174" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="772" y="200" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">VS SPY (ALPHA)</text>
  <text x="772" y="250" fill="${alphaColor}" font-size="50" font-weight="800" font-family="${F}">${alphaText}</text>

  <rect x="938" y="168" width="174" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="962" y="200" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">FOLLOWERS</text>
  <text x="962" y="250" fill="#f3f4f6" font-size="50" font-weight="700" font-family="${F}">${data.followerCount}</text>

  <rect x="748" y="308" width="174" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="772" y="340" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">NALA SCORE</text>
  <circle cx="784" cy="381" r="${scoreR}" fill="none" stroke="${grade.color}" stroke-width="3" opacity="0.15"/>
  <circle cx="784" cy="381" r="${scoreR}" fill="none" stroke="${grade.color}" stroke-width="3"
    stroke-dasharray="${scoreDash} ${scoreCirc}" stroke-linecap="round" transform="rotate(-90 784 381)"/>
  <text x="784" y="389" fill="${grade.color}" font-size="25" font-weight="800" text-anchor="middle" font-family="${F}">${scoreText}</text>
  <text x="834" y="389" fill="#88909b" font-size="14" font-family="${F}">/ 100</text>

  <rect x="938" y="308" width="174" height="126" rx="12" fill="rgba(11,15,18,0.95)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="962" y="340" fill="#7f8894" font-size="12" font-weight="600" letter-spacing="1.4" font-family="${F}">RANK</text>
  <text x="962" y="394" fill="${GREEN}" font-size="56" font-weight="800" font-family="${F}">${rankText}</text>

  <rect x="56" y="${H - 92}" width="${W - 112}" height="1" fill="rgba(255,255,255,0.08)"/>
  ${logoEl}
  <text x="102" y="${H - 37}" fill="#f3f4f6" font-size="17" font-weight="700" font-family="${F}">Nala</text>
  <text x="102" y="${H - 19}" fill="#7f8894" font-size="10" font-family="${F}">Portfolio Intelligence Platform</text>
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
