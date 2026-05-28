// Singleton Prisma client for the v2 ledger subsystem.
//
// IMPORTANT (v1 lesson): never instantiate PrismaClient per call. The v1
// codebase did `new Stripe(key)` per call and leaked connection pools — same
// hazard applies to Prisma. One module-level instance, lazy initialization,
// explicit teardown for tests only.
//
// Prisma 7 requires an adapter at PrismaClient construction time. For v2 we
// use @prisma/adapter-pg (Postgres). The connection string comes from
// V2_DATABASE_URL at first call — NOT at module load — so importing this
// file in a build that lacks the env doesn't crash. The first call to
// getLedgerClient() in such an env throws a clear error.

import { PrismaClient } from '../../generated/prisma-v2/client';
import { PrismaPg } from '@prisma/adapter-pg';

let cachedClient: PrismaClient | null = null;

export function getLedgerClient(): PrismaClient {
  if (!cachedClient) {
    const url = process.env.V2_DATABASE_URL;
    if (!url) {
      throw new Error(
        'V2_DATABASE_URL is not set in this environment. The v2 ledger ' +
          'client cannot be instantiated without a Postgres connection ' +
          'string. Set V2_DATABASE_URL on Railway (or in .env locally) ' +
          'before importing src/v2/ledger from any production code path.',
      );
    }
    const adapter = new PrismaPg({ connectionString: url });
    cachedClient = new PrismaClient({
      adapter,
      log:
        process.env.V2_LEDGER_DEBUG === 'true'
          ? ['query', 'info', 'warn', 'error']
          : ['warn', 'error'],
    });
  }
  return cachedClient;
}

// Test-only teardown. Production code must never call this — disconnecting
// the singleton kills in-flight queries.
export async function disconnectLedgerClientForTesting(): Promise<void> {
  if (cachedClient) {
    await cachedClient.$disconnect();
    cachedClient = null;
  }
}
