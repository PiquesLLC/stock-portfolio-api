/**
 * Finviz → ScreenerUniverse ingestion (manual / dev runs).
 *
 * Production self-bootstraps via `bootstrapScreenerUniverseIfEmpty` in
 * `src/services/screener-bootstrap.service.ts` — this script is for ad-hoc
 * re-ingests against a custom JSON path or local dev DB.
 *
 * Usage: `npx ts-node scripts/ingest-finviz-screener.ts [path-to-json]`
 *   defaults to `prisma/data/finviz_themes_detailed.json` (the bundled file).
 */
import * as path from 'node:path';
import prisma from '../src/utils/prisma';
import { ingestFromJsonFile } from '../src/services/screener-bootstrap.service';

const DEFAULT_PATH = path.join(__dirname, '..', 'prisma', 'data', 'finviz_themes_detailed.json');

async function main(): Promise<void> {
  const jsonPath = process.argv[2] ?? DEFAULT_PATH;
  console.log(`[ingest] reading ${path.resolve(jsonPath)}`);
  const start = Date.now();
  const { upserted, total } = await ingestFromJsonFile(jsonPath);
  console.log(`[ingest] done in ${Date.now() - start}ms — upserted ${upserted}, total ${total}`);
}

main()
  .catch(err => { console.error('[ingest] fatal:', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
