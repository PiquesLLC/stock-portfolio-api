// Singleton Prisma client for the v2 ledger subsystem.
//
// IMPORTANT (v1 lesson): never instantiate PrismaClient per call. The v1
// codebase did `new Stripe(key)` per call and leaked connection pools — same
// hazard applies to Prisma. One module-level instance, lazy initialization,
// explicit teardown for tests only.

import { PrismaClient } from '../../generated/prisma-v2/client';

let cachedClient: PrismaClient | null = null;

export function getLedgerClient(): PrismaClient {
  if (!cachedClient) {
    cachedClient = new PrismaClient({
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
