// Nala v2 — chart of accounts seeder
//
// Seeds the system accounts. Per-creator accounts (accountScope='creator')
// are created on-demand by application code at first earning (the
// `postTransaction` service will upsert the creator's account row before
// inserting any ledger entries for that creator).
//
// Idempotent: re-running is a no-op for accounts that already exist.
//
// Run: `npx ts-node prisma-v2/seed.ts`  (after `npm run prisma:v2:generate`)

// Prisma 7's `prisma-client` generator emits `client.ts` as the entry point —
// import from `<output>/client`, matching the v1 convention at
// `src/services/creator-billing.service.ts:4` which does
// `import { Prisma } from '../generated/prisma/client'`.
import { PrismaClient } from '../src/generated/prisma-v2/client';
import { PrismaPg } from '@prisma/adapter-pg';

const url = process.env.V2_DATABASE_URL;
if (!url) {
  throw new Error('V2_DATABASE_URL is not set. Cannot seed v2.');
}
// `disposeExternalPool` only applies when callers pass their own pool
// (per @prisma/adapter-pg types). We pass `connectionString`, so the
// adapter owns and manages the pool itself — the option is dead here,
// but keeping a connection-string-only config keeps seed simple.
const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

const SYSTEM_ACCOUNTS: Array<{
  accountScope: string;
  accountId: string;
  currency: string;
  purpose: string;
}> = [
  {
    accountScope: 'stripe_clearing',
    accountId: 'platform',
    currency: 'USD',
    purpose:
      'Virtual buffer for Stripe-side fact-of-money-moved. Every charge ' +
      'debits this account; every transfer credits it. Reconciles against ' +
      'Stripe.balance via the hourly cron.',
  },
  {
    accountScope: 'platform_revenue',
    accountId: 'platform',
    currency: 'USD',
    purpose: 'Nala net top-line. Credits from platform_fee splits.',
  },
  {
    accountScope: 'platform_fee',
    accountId: 'platform',
    currency: 'USD',
    purpose:
      'The 20% Nala take, posted as a debit against each invoice. The ' +
      'symmetric credit to platform_revenue happens in the same event group.',
  },
  {
    accountScope: 'tax_withholding',
    accountId: 'platform',
    currency: 'USD',
    purpose:
      '1099-K / 1042-S withholding holding account. Debits as withholding ' +
      'is taken from creator earnings; credits as remittance is filed.',
  },
  {
    accountScope: 'adjustment',
    accountId: 'platform',
    currency: 'USD',
    purpose:
      'Platform-funded manual adjustments. Debited when ops pays a creator ' +
      'out of pocket (v1 admin_fix). Counter-side for G6 mapper + future ' +
      'admin endpoint shadow-writes. No Stripe anchor — reconciles against ' +
      'an external ops ledger.',
  },
];

async function main() {
  console.log('[v2 seed] Ensuring system accounts...');
  for (const { accountScope, accountId, currency, purpose } of SYSTEM_ACCOUNTS) {
    const result = await prisma.account.upsert({
      where: {
        accountScope_accountId: { accountScope, accountId },
      },
      update: {}, // never touch existing accounts — preserves sequence_no
      create: { accountScope, accountId, currency },
    });
    console.log(
      `[v2 seed]   ${result.accountScope}:${result.accountId} (${result.currency}) — ${purpose}`,
    );
  }
  console.log(`[v2 seed] Done — ${SYSTEM_ACCOUNTS.length} system accounts ensured.`);
}

main()
  .catch((e) => {
    console.error('[v2 seed] FAILED:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
