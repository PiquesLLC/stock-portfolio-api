import sharp from 'sharp';
import prisma from '../utils/prisma';
import { getPerformanceComparison } from './benchmark.service';
import { getLeaderboard } from './leaderboard.service';

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

  // Fetch performance, leaderboard, and follower count in parallel
  const [performance, leaderboard, followerCount] = await Promise.all([
    getPerformanceComparison('1M', 'SPY', userId).catch(() => null),
    getLeaderboard('1M', 'world').catch(() => null),
    prisma.follow.count({ where: { followingId: userId } }),
  ]);

  // Find leaderboard rank
  let leaderboardRank: number | null = null;
  let nalaScore: number | null = null;
  if (leaderboard?.entries) {
    const idx = leaderboard.entries.findIndex((e: { userId: string }) => e.userId === userId);
    if (idx >= 0) {
      leaderboardRank = idx + 1;
    }
  }

  // Nala score from signal score if available
  if (performance) {
    // Simple signal score: weighted combination of return, alpha, low volatility
    const ret = performance.twrPct ?? performance.simpleReturnPct ?? 0;
    const alpha = performance.alphaPct ?? 0;
    const vol = performance.volatilityPct ?? 20;
    const raw = Math.min(100, Math.max(0,
      50 + (ret * 1.5) + (alpha * 2) - (vol * 0.5)
    ));
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

function buildSvg(data: ShareCardData): string {
  const W = 1200;
  const H = 630;
  const GREEN = '#00c805';
  const RED = '#e8544e';
  const BG = '#0d0d0f';
  const CARD = '#1a1a1e';
  const BORDER = '#2a2a2e';
  const MUTED = '#888888';
  const WHITE = '#ffffff';

  const retPct = data.returnPct;
  const retColor = retPct != null ? (retPct >= 0 ? GREEN : RED) : MUTED;
  const retText = retPct != null ? `${retPct >= 0 ? '+' : ''}${retPct.toFixed(1)}%` : 'N/A';

  const alphaText = data.alphaPct != null ? `${data.alphaPct >= 0 ? '+' : ''}${data.alphaPct.toFixed(1)}%` : 'N/A';
  const alphaColor = data.alphaPct != null ? (data.alphaPct >= 0 ? GREEN : RED) : MUTED;

  const betaText = data.beta != null ? data.beta.toFixed(2) : 'N/A';

  const rankText = data.leaderboardRank != null ? `#${data.leaderboardRank}` : '--';

  const scoreText = data.nalaScore != null ? `${data.nalaScore}` : '--';
  const scoreColor = data.nalaScore != null
    ? (data.nalaScore >= 80 ? GREEN : data.nalaScore >= 60 ? '#eab308' : RED)
    : MUTED;

  const initials = data.displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  const creatorBadge = data.isCreator
    ? `<rect x="310" y="108" width="70" height="22" rx="6" fill="${GREEN}" opacity="0.15"/>
       <text x="345" y="123" fill="${GREEN}" font-size="11" font-weight="600" text-anchor="middle" font-family="sans-serif">Creator</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="cardGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111114"/>
      <stop offset="100%" stop-color="#0d0d0f"/>
    </linearGradient>
    <clipPath id="avatarClip"><circle cx="105" cy="100" r="40"/></clipPath>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="${BG}"/>

  <!-- Main card -->
  <rect x="40" y="30" width="${W - 80}" height="${H - 60}" rx="24" fill="${CARD}" stroke="${BORDER}" stroke-width="1"/>

  <!-- Green accent line at top -->
  <rect x="40" y="30" width="${W - 80}" height="4" rx="2" fill="${GREEN}" opacity="0.6"/>

  <!-- Avatar circle -->
  <circle cx="105" cy="100" r="40" fill="${GREEN}" opacity="0.15"/>
  <text x="105" y="110" fill="${GREEN}" font-size="24" font-weight="700" text-anchor="middle" font-family="sans-serif">${initials}</text>

  <!-- Name + username -->
  <text x="165" y="92" fill="${WHITE}" font-size="28" font-weight="700" font-family="sans-serif">${escapeXml(data.displayName)}</text>
  <text x="165" y="118" fill="${MUTED}" font-size="16" font-family="sans-serif">@${escapeXml(data.username)}</text>
  ${creatorBadge}

  <!-- Followers -->
  <text x="165" y="145" fill="${MUTED}" font-size="14" font-family="sans-serif">
    <tspan fill="${WHITE}" font-weight="600">${data.followerCount}</tspan> follower${data.followerCount !== 1 ? 's' : ''}
  </text>

  <!-- Divider -->
  <line x1="80" y1="175" x2="${W - 80}" y2="175" stroke="${BORDER}" stroke-width="1"/>

  <!-- Stats grid - Row 1 -->
  <!-- Return (1M) -->
  <text x="160" y="225" fill="${MUTED}" font-size="12" font-weight="600" text-anchor="middle" font-family="sans-serif" letter-spacing="1">RETURN (1MO)</text>
  <text x="160" y="275" fill="${retColor}" font-size="42" font-weight="800" text-anchor="middle" font-family="sans-serif">${retText}</text>

  <!-- vs SPY -->
  <text x="400" y="225" fill="${MUTED}" font-size="12" font-weight="600" text-anchor="middle" font-family="sans-serif" letter-spacing="1">VS SPY</text>
  <text x="400" y="275" fill="${alphaColor}" font-size="42" font-weight="800" text-anchor="middle" font-family="sans-serif">${alphaText}</text>

  <!-- Beta -->
  <text x="640" y="225" fill="${MUTED}" font-size="12" font-weight="600" text-anchor="middle" font-family="sans-serif" letter-spacing="1">BETA</text>
  <text x="640" y="275" fill="${WHITE}" font-size="42" font-weight="800" text-anchor="middle" font-family="sans-serif">${betaText}</text>

  <!-- Nala Score -->
  <text x="880" y="225" fill="${MUTED}" font-size="12" font-weight="600" text-anchor="middle" font-family="sans-serif" letter-spacing="1">NALA SCORE</text>
  <circle cx="880" cy="265" r="32" fill="none" stroke="${scoreColor}" stroke-width="3" opacity="0.3"/>
  <circle cx="880" cy="265" r="32" fill="none" stroke="${scoreColor}" stroke-width="3"
    stroke-dasharray="${data.nalaScore != null ? (data.nalaScore / 100) * 201 : 0} 201"
    transform="rotate(-90 880 265)"/>
  <text x="880" y="275" fill="${scoreColor}" font-size="28" font-weight="800" text-anchor="middle" font-family="sans-serif">${scoreText}</text>

  <!-- Leaderboard rank -->
  <text x="1060" y="225" fill="${MUTED}" font-size="12" font-weight="600" text-anchor="middle" font-family="sans-serif" letter-spacing="1">RANK</text>
  <text x="1060" y="275" fill="${GREEN}" font-size="42" font-weight="800" text-anchor="middle" font-family="sans-serif">${rankText}</text>

  <!-- Divider -->
  <line x1="80" y1="320" x2="${W - 80}" y2="320" stroke="${BORDER}" stroke-width="1"/>

  <!-- Bottom section - CTA -->
  <text x="105" y="380" fill="${MUTED}" font-size="15" font-family="sans-serif">Track your portfolio. Compare with the best. Get smarter.</text>

  <!-- Nala branding -->
  <rect x="80" y="420" width="1040" height="56" rx="12" fill="${GREEN}" opacity="0.08"/>
  <text x="110" y="455" fill="${GREEN}" font-size="28" font-weight="800" font-family="sans-serif">N</text>
  <text x="140" y="455" fill="${WHITE}" font-size="20" font-weight="600" font-family="sans-serif">Nala</text>
  <text x="600" y="455" fill="${MUTED}" font-size="14" text-anchor="middle" font-family="sans-serif">Portfolio Intelligence Platform</text>
  <text x="${W - 110}" y="455" fill="${GREEN}" font-size="16" font-weight="600" text-anchor="end" font-family="sans-serif">nalaai.com</text>

  <!-- Disclaimer -->
  <text x="${W / 2}" y="${H - 50}" fill="#333333" font-size="10" text-anchor="middle" font-family="sans-serif">Educational content only. Not investment advice. Past performance does not guarantee future results.</text>
</svg>`;
}

export async function generateShareCard(userId: string): Promise<Buffer | null> {
  const data = await getShareCardData(userId);
  if (!data) return null;

  const svg = buildSvg(data);
  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(1200, 630)
    .png({ quality: 90 })
    .toBuffer();

  return pngBuffer;
}
