/**
 * Screener Universe bootstrap.
 *
 * Production deploys ship with `prisma/data/finviz_themes_detailed.json`. On
 * first boot after the `ScreenerUniverse` table is created, this service
 * detects an empty table and ingests ~945 tickers + theme tags from the bundled
 * JSON. Idempotent — subsequent boots find rows present and skip.
 *
 * The standalone `scripts/ingest-finviz-screener.ts` reuses `ingestFromJsonFile`
 * for ad-hoc dev runs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import prisma from '../utils/prisma';

interface FinvizSubtheme { name: string; tickers: string[] }
interface FinvizTheme { theme: string; subthemes: FinvizSubtheme[] }
interface FinvizDetailed { generatedAt?: string; themeCount?: number; themes: FinvizTheme[] }
interface TickerThemeTag { theme: string; subthemes: string[] }

const BUNDLED_FINVIZ_PATH = path.join(__dirname, '..', '..', 'prisma', 'data', 'finviz_themes_detailed.json');

function buildThemeIndex(detailed: FinvizDetailed): Map<string, TickerThemeTag[]> {
  const byTicker = new Map<string, TickerThemeTag[]>();
  for (const t of detailed.themes) {
    const subthemesByTicker = new Map<string, Set<string>>();
    for (const sub of t.subthemes) {
      for (const rawTicker of sub.tickers) {
        const ticker = rawTicker.toUpperCase().trim();
        if (!ticker) continue;
        const existing = subthemesByTicker.get(ticker) ?? new Set<string>();
        existing.add(sub.name);
        subthemesByTicker.set(ticker, existing);
      }
    }
    for (const [ticker, subSet] of subthemesByTicker) {
      const list = byTicker.get(ticker) ?? [];
      list.push({ theme: t.theme, subthemes: Array.from(subSet).sort() });
      byTicker.set(ticker, list);
    }
  }
  return byTicker;
}

export async function ingestFromJsonFile(jsonPath: string): Promise<{ upserted: number; total: number }> {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Finviz JSON not found at ${jsonPath}`);
  }
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const detailed = JSON.parse(raw) as FinvizDetailed;
  const byTicker = buildThemeIndex(detailed);

  let upserted = 0;
  for (const ticker of Array.from(byTicker.keys()).sort()) {
    const tags = byTicker.get(ticker) ?? [];
    await prisma.screenerUniverse.upsert({
      where: { ticker },
      create: { ticker, themesJson: JSON.stringify(tags), source: 'finviz' },
      // Don't touch `source` on existing rows — could be 'curated' from another loader.
      update: { themesJson: JSON.stringify(tags) },
    });
    upserted++;
  }
  const total = await prisma.screenerUniverse.count();
  return { upserted, total };
}

/**
 * Self-bootstrap: if the universe table is empty AND a bundled Finviz JSON is
 * shipped with the deploy, ingest in the background. Safe to await or fire-and-
 * forget — designed not to throw.
 */
export async function bootstrapScreenerUniverseIfEmpty(): Promise<void> {
  try {
    const count = await prisma.screenerUniverse.count();
    if (count > 0) {
      console.log(`[Screener Bootstrap] Universe already has ${count} rows — skipping ingest`);
      return;
    }
    if (!fs.existsSync(BUNDLED_FINVIZ_PATH)) {
      console.warn(`[Screener Bootstrap] Bundled Finviz JSON not found at ${BUNDLED_FINVIZ_PATH} — skipping`);
      return;
    }
    console.log('[Screener Bootstrap] Empty universe — ingesting bundled Finviz themes…');
    const start = Date.now();
    const { upserted, total } = await ingestFromJsonFile(BUNDLED_FINVIZ_PATH);
    console.log(`[Screener Bootstrap] Done in ${Date.now() - start}ms — upserted ${upserted}, total ${total}`);
  } catch (err) {
    // P2021 = table doesn't exist yet (migration hasn't applied). Swallow and let
    // the next request after migration complete trigger the bootstrap. Other
    // errors are logged but never thrown — bootstrap is best-effort.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Screener Bootstrap] Failed (non-fatal):', msg);
  }
}
