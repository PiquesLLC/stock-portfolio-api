// Pre-cutover freeze helper for v1 CreatorWalletLedger writes.
//
// When `V1_WALLET_FREEZE=true` is set, every call to `v1LedgerCreate` returns
// a no-op `SELECT 1` PrismaPromise instead of inserting a CreatorWalletLedger
// row. The v2 shadow-writes that sit alongside each v1 write are NOT affected
// — they continue to fire and become the source of truth.
//
// USAGE
//   - Wherever production code currently has `prisma.creatorWalletLedger.create({...})`
//     or `tx.creatorWalletLedger.create({...})`, replace with:
//       `v1LedgerCreate(prisma, {...})` / `v1LedgerCreate(tx, {...})`.
//   - The return value is still a `Prisma.PrismaPromise<unknown>` so it can
//     be embedded in `$transaction([...])` arrays without further changes.
//
// WHY A NO-OP `SELECT 1` AND NOT JUST SKIPPING THE CALL
//   - Callers embed these calls in `prisma.$transaction([...])` arrays whose
//     types require `Prisma.PrismaPromise`. Returning `null` or skipping
//     would force every $transaction call site to `.filter(Boolean)` and
//     cast the type — a much larger refactor than the freeze deserves.
//   - `SELECT 1` is the canonical Postgres no-op (v1's prod DB). It runs
//     inside the same transaction so isolation guarantees are preserved;
//     under Serializable isolation it acquires no locks and does not
//     contribute to the serialization read-set (no FROM clause).
//
// FREEZE LIFECYCLE
//   - Day T-N: this helper lands; all v1 write call sites get refactored
//     to use it. `V1_WALLET_FREEZE` is unset → behavior is unchanged.
//   - Day T+0 (cutover): ops sets `V1_WALLET_FREEZE=true` on Railway,
//     redeploys; all v1 writes silently no-op while v2 shadow-writes
//     become authoritative.
//   - Day T+7d: helper + every call site can be deleted alongside the rest
//     of the v1 decommission (see docs/v2-cutover.md).
//
// LOG CADENCE
//   - When frozen, we log once per minute that suppression is active. This
//     gives ops visibility without spamming logs on high-throughput billing
//     paths (a `charge.refunded` storm could fire dozens of suppressions
//     per second). The lastLogAt is module-mutable — restarts reset it,
//     which is fine because a fresh process logs immediately on the next
//     suppressed write.

import { Prisma } from '../generated/prisma/client';

const FREEZE_ENV = 'V1_WALLET_FREEZE';
const LOG_COOLDOWN_MS = 60_000;
let lastLogAt = 0;

export function isV1WalletFrozen(): boolean {
  return process.env[FREEZE_ENV] === 'true';
}

type V1LedgerClient = {
  creatorWalletLedger: {
    create: (
      args: Prisma.CreatorWalletLedgerCreateArgs,
    ) => Prisma.PrismaPromise<unknown>;
  };
  $queryRaw: <T = unknown>(
    template: TemplateStringsArray,
    ...args: unknown[]
  ) => Prisma.PrismaPromise<T>;
};

/**
 * Conditionally create a v1 CreatorWalletLedger row.
 *
 * - When `V1_WALLET_FREEZE` is NOT 'true': identical to
 *   `client.creatorWalletLedger.create(args)`.
 * - When `V1_WALLET_FREEZE` is 'true': returns a no-op `SELECT 1` and logs
 *   suppression at most once per minute.
 *
 * @param client  Either the top-level `prisma` instance OR the interactive
 *                transaction client `tx` (Prisma supplies both with the
 *                same shape for `creatorWalletLedger.create` and `$queryRaw`).
 * @param args    Exactly the args you'd pass to `.create({ data: {...} })`.
 */
export function v1LedgerCreate<C extends V1LedgerClient>(
  client: C,
  args: Prisma.CreatorWalletLedgerCreateArgs,
): Prisma.PrismaPromise<unknown> {
  if (isV1WalletFrozen()) {
    const now = Date.now();
    if (now - lastLogAt > LOG_COOLDOWN_MS) {
      lastLogAt = now;
      console.log(
        '[V1 Freeze] active — v1 ledger writes suppressed (logging at most once per 60s).',
      );
    }
    return client.$queryRaw`SELECT 1`;
  }
  return client.creatorWalletLedger.create(args);
}
