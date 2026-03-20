#!/usr/bin/env node
// Seeds the top 25 billionaires into the Billionaire table.
// Safe to run multiple times — uses upsert on name.
//
// Data sourced from Bloomberg Billionaires Index (March 19, 2026).
// baseNetWorthUsd = Bloomberg total - (shares × live stock price)
// This ensures computedNetWorth closely tracks Bloomberg when quotes are fresh.
//
// Stock prices used for calibration (March 20, 2026):
//   TSLA=$366, AMZN=$205, META=$590, ORCL=$149, LVMUY=$105,
//   BRK-B=$481, MSFT=$381, GOOGL=$299, NVDA=$173, WMT=$120,
//   NKE=$52, DELL=$159, NFLX=$91 (post 10:1 split Jun 2025)

const path = require('path');
const { PrismaLibSql } = require('@prisma/adapter-libsql');
const { PrismaClient } = require('../dist/generated/prisma/client.js');

const dbPath = path.resolve(__dirname, '..', 'prisma', 'dev.db');
const adapter = new PrismaLibSql({ url: 'file:' + dbPath });
const prisma = new PrismaClient({ adapter });

const BILLIONAIRES = [
  {
    name: 'Elon Musk',
    slug: 'elon-musk',
    company: 'Tesla / SpaceX',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $650B. TSLA 411M × $366 = $150B. SpaceX-xAI = ~$500B.
    baseNetWorthUsd: 500_000_000_000,
    holdings: [{ ticker: 'TSLA', shares: 411_000_000, note: 'Includes trust holdings' }],
  },
  {
    name: 'Larry Page',
    slug: 'larry-page',
    company: 'Alphabet',
    title: 'Co-founder',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $253B. GOOGL 395M × $299 = $118B.
    baseNetWorthUsd: 135_000_000_000,
    holdings: [{ ticker: 'GOOGL', shares: 395_000_000, note: 'Class A + C (post-split)' }],
  },
  {
    name: 'Sergey Brin',
    slug: 'sergey-brin',
    company: 'Alphabet',
    title: 'Co-founder',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $245B. GOOGL 372M × $299 = $111B.
    baseNetWorthUsd: 134_000_000_000,
    holdings: [{ ticker: 'GOOGL', shares: 372_000_000, note: 'Class A + C (post-split)' }],
  },
  {
    name: 'Jeff Bezos',
    slug: 'jeff-bezos',
    company: 'Amazon',
    title: 'Executive Chairman',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $215B. AMZN 945M × $205 = $194B. Blue Origin + investments.
    baseNetWorthUsd: 21_000_000_000,
    holdings: [{ ticker: 'AMZN', shares: 945_000_000, note: 'Per latest SEC filing (post-split)' }],
  },
  {
    name: 'Mark Zuckerberg',
    slug: 'mark-zuckerberg',
    company: 'Meta',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $215B. META 350M × $590 = $207B.
    baseNetWorthUsd: 8_000_000_000,
    holdings: [{ ticker: 'META', shares: 350_000_000, note: 'Class A + B combined' }],
  },
  {
    name: 'Larry Ellison',
    slug: 'larry-ellison',
    company: 'Oracle',
    title: 'CTO & Chairman',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $193B. ORCL 1.17B × $149 = $174B. Real estate + investments.
    baseNetWorthUsd: 19_000_000_000,
    holdings: [{ ticker: 'ORCL', shares: 1_170_000_000, note: 'Direct + trust' }],
  },
  {
    name: 'Jensen Huang',
    slug: 'jensen-huang',
    company: 'NVIDIA',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $148B. NVDA 579M × $173 = $100B. (post 10:1 split 2024)
    baseNetWorthUsd: 48_000_000_000,
    holdings: [{ ticker: 'NVDA', shares: 579_000_000, note: 'Post 10:1 split' }],
  },
  {
    name: 'Michael Dell',
    slug: 'michael-dell',
    company: 'Dell Technologies',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $144B. DELL 543M × $159 = $86B. MSD Capital diversified.
    baseNetWorthUsd: 58_000_000_000,
    holdings: [{ ticker: 'DELL', shares: 543_000_000, note: 'Direct + MSD Capital' }],
  },
  {
    name: 'Jim Walton',
    slug: 'jim-walton',
    company: 'Walmart / Arvest Bank',
    title: 'Chairman, Arvest Bank',
    country: 'US',
    industry: 'Retail',
    // Bloomberg: $143B. WMT 860M × $120 = $103B. Arvest Bank + other.
    baseNetWorthUsd: 40_000_000_000,
    holdings: [{ ticker: 'WMT', shares: 860_000_000, note: 'Walton family trust (post 3:1 split)' }],
  },
  {
    name: 'Rob Walton',
    slug: 'rob-walton',
    company: 'Walmart',
    title: 'Former Chairman',
    country: 'US',
    industry: 'Retail',
    // Bloomberg: $143B. WMT 860M × $120 = $103B.
    baseNetWorthUsd: 40_000_000_000,
    holdings: [{ ticker: 'WMT', shares: 860_000_000, note: 'Walton family trust (post 3:1 split)' }],
  },
  {
    name: 'Warren Buffett',
    slug: 'warren-buffett',
    company: 'Berkshire Hathaway',
    title: 'Chairman & CEO',
    country: 'US',
    industry: 'Finance',
    // Bloomberg: $143B. BRK-B 298M × $481 = $143B. Nearly all in BRK.
    baseNetWorthUsd: 0,
    holdings: [{ ticker: 'BRK-B', shares: 298_000_000, note: 'A-shares converted to B-equivalent (after donations)' }],
  },
  {
    name: 'Steve Ballmer',
    slug: 'steve-ballmer',
    company: 'LA Clippers',
    title: 'Owner',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $138B. MSFT 333M × $381 = $127B. LA Clippers + investments.
    baseNetWorthUsd: 11_000_000_000,
    holdings: [{ ticker: 'MSFT', shares: 333_000_000, note: 'Largest individual MSFT holder' }],
  },
  {
    name: 'Bernard Arnault',
    slug: 'bernard-arnault',
    company: 'LVMH',
    title: 'Chairman & CEO',
    country: 'France',
    industry: 'Luxury',
    // Bloomberg: $153B. LVMUY ADR only captures partial stake. Most in family holding.
    baseNetWorthUsd: 143_000_000_000,
    holdings: [{ ticker: 'LVMUY', shares: 97_000_000, note: 'ADR equivalent (partial)' }],
  },
  {
    name: 'Alice Walton',
    slug: 'alice-walton',
    company: 'Walmart',
    title: 'Heiress',
    country: 'US',
    industry: 'Retail',
    // Bloomberg: ~$130B. WMT 751M × $120 = $90B.
    baseNetWorthUsd: 40_000_000_000,
    holdings: [{ ticker: 'WMT', shares: 751_000_000, note: 'Walton family trust (post 3:1 split)' }],
  },
  {
    name: 'Amancio Ortega',
    slug: 'amancio-ortega',
    company: 'Inditex (Zara)',
    title: 'Founder',
    country: 'Spain',
    industry: 'Retail',
    // Bloomberg: $122B. Inditex on BME, not easily quotable.
    baseNetWorthUsd: 122_000_000_000,
    holdings: [],
  },
  {
    name: 'Carlos Slim',
    slug: 'carlos-slim',
    company: 'Grupo Carso',
    title: 'Chairman',
    country: 'Mexico',
    industry: 'Telecom',
    // Bloomberg: $112B. América Móvil + private holdings.
    baseNetWorthUsd: 112_000_000_000,
    holdings: [],
  },
  {
    name: 'Bill Gates',
    slug: 'bill-gates',
    company: 'Cascade Investment',
    title: 'Co-chair, Gates Foundation',
    country: 'US',
    industry: 'Technology',
    // Bloomberg: $98B. MSFT 50M × $381 = $19B. Cascade diversified = $79B.
    baseNetWorthUsd: 79_000_000_000,
    holdings: [{ ticker: 'MSFT', shares: 50_000_000, note: 'Greatly reduced over years' }],
  },
  {
    name: 'Mukesh Ambani',
    slug: 'mukesh-ambani',
    company: 'Reliance Industries',
    title: 'Chairman',
    country: 'India',
    industry: 'Conglomerate',
    // Bloomberg: $91B. Reliance on NSE, not quotable here.
    baseNetWorthUsd: 91_000_000_000,
    holdings: [],
  },
  {
    name: 'Francoise Bettencourt Meyers',
    slug: 'francoise-bettencourt',
    company: "L'Oreal",
    title: 'Chairwoman',
    country: 'France',
    industry: 'Consumer',
    // Bloomberg: $81B. L'Oreal on Euronext.
    baseNetWorthUsd: 81_000_000_000,
    holdings: [],
  },
  {
    name: 'Michael Bloomberg',
    slug: 'michael-bloomberg',
    company: 'Bloomberg LP',
    title: 'Co-founder & CEO',
    country: 'US',
    industry: 'Media',
    // ~$95B. All private (Bloomberg LP 88% stake).
    baseNetWorthUsd: 95_000_000_000,
    holdings: [],
  },
  {
    name: 'Gautam Adani',
    slug: 'gautam-adani',
    company: 'Adani Group',
    title: 'Chairman',
    country: 'India',
    industry: 'Industrial',
    // Bloomberg: $76B. Indian exchange stocks.
    baseNetWorthUsd: 76_000_000_000,
    holdings: [],
  },
  {
    name: 'Phil Knight',
    slug: 'phil-knight',
    company: 'Nike',
    title: 'Chairman Emeritus',
    country: 'US',
    industry: 'Consumer',
    // ~$45B. NKE 250M × $52 = $13B.
    baseNetWorthUsd: 32_000_000_000,
    holdings: [{ ticker: 'NKE', shares: 250_000_000, note: 'Class A shares' }],
  },
  {
    name: 'Ken Griffin',
    slug: 'ken-griffin',
    company: 'Citadel',
    title: 'CEO',
    country: 'US',
    industry: 'Finance',
    // ~$45B. Private fund.
    baseNetWorthUsd: 45_000_000_000,
    holdings: [],
  },
  {
    name: 'MacKenzie Scott',
    slug: 'mackenzie-scott',
    company: 'Philanthropist',
    title: 'Author & Philanthropist',
    country: 'US',
    industry: 'Philanthropy',
    // ~$36B. AMZN 56M × $205 = $11.5B.
    baseNetWorthUsd: 25_000_000_000,
    holdings: [{ ticker: 'AMZN', shares: 56_000_000, note: 'Post-divorce, reduced by giving' }],
  },
  {
    name: 'Reed Hastings',
    slug: 'reed-hastings',
    company: 'Netflix',
    title: 'Executive Chairman',
    country: 'US',
    industry: 'Entertainment',
    // ~$7B. NFLX 55M × $91 = $5B. (post 10:1 split Jun 2025)
    baseNetWorthUsd: 2_000_000_000,
    holdings: [{ ticker: 'NFLX', shares: 55_000_000, note: 'Post 10:1 split' }],
  },
];

async function main() {
  console.log('Seeding billionaires (Bloomberg Billionaires Index, March 2026)...\n');

  let count = 0;
  for (const b of BILLIONAIRES) {
    await prisma.billionaire.upsert({
      where: { name: b.name },
      create: {
        name: b.name,
        slug: b.slug,
        company: b.company,
        title: b.title,
        country: b.country,
        industry: b.industry,
        baseNetWorthUsd: b.baseNetWorthUsd,
        holdings: JSON.stringify(b.holdings),
        source: 'bloomberg',
      },
      update: {
        slug: b.slug,
        company: b.company,
        title: b.title,
        country: b.country,
        industry: b.industry,
        baseNetWorthUsd: b.baseNetWorthUsd,
        holdings: JSON.stringify(b.holdings),
        source: 'bloomberg',
      },
    });
    count++;
    const holdingsTxt = b.holdings.length > 0
      ? b.holdings.map(h => `${h.ticker} (${(h.shares / 1_000_000).toFixed(1)}M shares)`).join(', ')
      : 'No public holdings (private)';
    console.log(`  [${count}/${BILLIONAIRES.length}] ${b.name} — base $${(b.baseNetWorthUsd / 1e9).toFixed(0)}B — ${holdingsTxt}`);
  }

  console.log(`\nDone. Seeded ${count} billionaires.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
