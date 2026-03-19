#!/usr/bin/env node
// Seeds the top 25 billionaires into the Billionaire table.
// Safe to run multiple times — uses upsert on name.

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
    baseNetWorthUsd: 110_000_000_000,
    holdings: [{ ticker: 'TSLA', shares: 411_000_000, note: 'Includes trust holdings' }],
  },
  {
    name: 'Jeff Bezos',
    slug: 'jeff-bezos',
    company: 'Amazon',
    title: 'Executive Chairman',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 30_000_000_000,
    holdings: [{ ticker: 'AMZN', shares: 988_000_000, note: 'Per latest SEC filing' }],
  },
  {
    name: 'Mark Zuckerberg',
    slug: 'mark-zuckerberg',
    company: 'Meta',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 5_000_000_000,
    holdings: [{ ticker: 'META', shares: 350_000_000, note: 'Class A + B combined' }],
  },
  {
    name: 'Larry Ellison',
    slug: 'larry-ellison',
    company: 'Oracle',
    title: 'CTO & Chairman',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 10_000_000_000,
    holdings: [{ ticker: 'ORCL', shares: 1_170_000_000, note: 'Direct + trust' }],
  },
  {
    name: 'Bernard Arnault',
    slug: 'bernard-arnault',
    company: 'LVMH',
    title: 'Chairman & CEO',
    country: 'France',
    industry: 'Luxury',
    baseNetWorthUsd: 50_000_000_000,
    holdings: [{ ticker: 'LVMUY', shares: 97_000_000, note: 'ADR equivalent' }],
  },
  {
    name: 'Warren Buffett',
    slug: 'warren-buffett',
    company: 'Berkshire Hathaway',
    title: 'Chairman & CEO',
    country: 'US',
    industry: 'Finance',
    baseNetWorthUsd: 5_000_000_000,
    holdings: [{ ticker: 'BRK-B', shares: 942_000_000, note: 'A-shares converted to B-equivalent' }],
  },
  {
    name: 'Bill Gates',
    slug: 'bill-gates',
    company: 'Cascade Investment',
    title: 'Co-chair, Gates Foundation',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 50_000_000_000,
    holdings: [{ ticker: 'MSFT', shares: 100_000_000, note: 'Reduced over years' }],
  },
  {
    name: 'Larry Page',
    slug: 'larry-page',
    company: 'Alphabet',
    title: 'Co-founder',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 20_000_000_000,
    holdings: [{ ticker: 'GOOGL', shares: 39_000_000, note: 'Class A + C combined' }],
  },
  {
    name: 'Sergey Brin',
    slug: 'sergey-brin',
    company: 'Alphabet',
    title: 'Co-founder',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 20_000_000_000,
    holdings: [{ ticker: 'GOOGL', shares: 37_500_000, note: 'Class A + C combined' }],
  },
  {
    name: 'Steve Ballmer',
    slug: 'steve-ballmer',
    company: 'LA Clippers',
    title: 'Owner',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 5_000_000_000,
    holdings: [{ ticker: 'MSFT', shares: 333_000_000, note: 'Largest individual MSFT holder' }],
  },
  {
    name: 'Jensen Huang',
    slug: 'jensen-huang',
    company: 'NVIDIA',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 2_000_000_000,
    holdings: [{ ticker: 'NVDA', shares: 75_000_000, note: 'After stock splits' }],
  },
  {
    name: 'Michael Dell',
    slug: 'michael-dell',
    company: 'Dell Technologies',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 15_000_000_000,
    holdings: [{ ticker: 'DELL', shares: 543_000_000, note: 'Direct + MSD Capital' }],
  },
  {
    name: 'Jim Walton',
    slug: 'jim-walton',
    company: 'Walmart / Arvest Bank',
    title: 'Chairman, Arvest Bank',
    country: 'US',
    industry: 'Retail',
    baseNetWorthUsd: 5_000_000_000,
    holdings: [{ ticker: 'WMT', shares: 330_000_000, note: 'Walton family trust' }],
  },
  {
    name: 'Rob Walton',
    slug: 'rob-walton',
    company: 'Walmart',
    title: 'Former Chairman',
    country: 'US',
    industry: 'Retail',
    baseNetWorthUsd: 5_000_000_000,
    holdings: [{ ticker: 'WMT', shares: 330_000_000, note: 'Walton family trust' }],
  },
  {
    name: 'Alice Walton',
    slug: 'alice-walton',
    company: 'Walmart',
    title: 'Heiress',
    country: 'US',
    industry: 'Retail',
    baseNetWorthUsd: 8_000_000_000,
    holdings: [{ ticker: 'WMT', shares: 290_000_000, note: 'Walton family trust' }],
  },
  {
    name: 'Phil Knight',
    slug: 'phil-knight',
    company: 'Nike',
    title: 'Chairman Emeritus',
    country: 'US',
    industry: 'Consumer',
    baseNetWorthUsd: 10_000_000_000,
    holdings: [{ ticker: 'NKE', shares: 250_000_000, note: 'Class A shares' }],
  },
  {
    name: 'MacKenzie Scott',
    slug: 'mackenzie-scott',
    company: 'Philanthropist',
    title: 'Author & Philanthropist',
    country: 'US',
    industry: 'Philanthropy',
    baseNetWorthUsd: 5_000_000_000,
    holdings: [{ ticker: 'AMZN', shares: 56_000_000, note: 'Post-divorce settlement, reduced by giving' }],
  },
  {
    name: 'Michael Bloomberg',
    slug: 'michael-bloomberg',
    company: 'Bloomberg LP',
    title: 'Co-founder & CEO',
    country: 'US',
    industry: 'Media',
    baseNetWorthUsd: 95_000_000_000,
    holdings: [],
  },
  {
    name: 'Ken Griffin',
    slug: 'ken-griffin',
    company: 'Citadel',
    title: 'CEO',
    country: 'US',
    industry: 'Finance',
    baseNetWorthUsd: 45_000_000_000,
    holdings: [],
  },
  {
    name: 'Charles Koch',
    slug: 'charles-koch',
    company: 'Koch Industries',
    title: 'Chairman & CEO',
    country: 'US',
    industry: 'Conglomerate',
    baseNetWorthUsd: 65_000_000_000,
    holdings: [],
  },
  {
    name: 'Julia Koch',
    slug: 'julia-koch',
    company: 'Koch Industries',
    title: 'Heir',
    country: 'US',
    industry: 'Conglomerate',
    baseNetWorthUsd: 65_000_000_000,
    holdings: [],
  },
  {
    name: 'Jamie Dimon',
    slug: 'jamie-dimon',
    company: 'JPMorgan Chase',
    title: 'CEO',
    country: 'US',
    industry: 'Finance',
    baseNetWorthUsd: 1_000_000_000,
    holdings: [{ ticker: 'JPM', shares: 8_500_000, note: 'Per latest proxy' }],
  },
  {
    name: 'Satya Nadella',
    slug: 'satya-nadella',
    company: 'Microsoft',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 500_000_000,
    holdings: [{ ticker: 'MSFT', shares: 3_000_000, note: 'After regular sales' }],
  },
  {
    name: 'Tim Cook',
    slug: 'tim-cook',
    company: 'Apple',
    title: 'CEO',
    country: 'US',
    industry: 'Technology',
    baseNetWorthUsd: 500_000_000,
    holdings: [{ ticker: 'AAPL', shares: 3_280_000, note: 'Per latest Form 4' }],
  },
  {
    name: 'Reed Hastings',
    slug: 'reed-hastings',
    company: 'Netflix',
    title: 'Executive Chairman',
    country: 'US',
    industry: 'Entertainment',
    baseNetWorthUsd: 1_000_000_000,
    holdings: [{ ticker: 'NFLX', shares: 5_500_000, note: 'Per latest filing' }],
  },
];

async function main() {
  console.log('Seeding billionaires...\n');

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
        source: 'manual',
      },
      update: {
        slug: b.slug,
        company: b.company,
        title: b.title,
        country: b.country,
        industry: b.industry,
        baseNetWorthUsd: b.baseNetWorthUsd,
        holdings: JSON.stringify(b.holdings),
        source: 'manual',
      },
    });
    count++;
    const holdingsTxt = b.holdings.length > 0
      ? b.holdings.map(h => `${h.ticker} (${(h.shares / 1_000_000).toFixed(1)}M shares)`).join(', ')
      : 'No public holdings';
    console.log(`  [${count}/${BILLIONAIRES.length}] ${b.name} — ${b.company} — ${holdingsTxt}`);
  }

  console.log(`\nDone. Seeded ${count} billionaires.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
