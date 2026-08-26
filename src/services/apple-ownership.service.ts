import type { QueueClient } from './apple-reconciliation-queue.service';
import { PRODUCTION_ENVIRONMENT } from './apple-entitlement-projection.service';

/**
 * Who owns an Apple subscription.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE:
 *
 *   Possessing a valid signed Apple transaction is not a claim to it.
 *
 * The legacy path treated it as one: /apple-verify took the originalTransactionId
 * out of a client-submitted JWS and wrote it onto whichever account happened to
 * be calling. Anyone who obtained another person's signed transaction — from a
 * shared device, a jailbroken client, a leaked payload — could attach that
 * subscription to their own account.
 *
 * Ownership now comes from a token WE issued. The server mints an opaque UUIDv4
 * into User.appleAppAccountToken, the client passes it to StoreKit as
 * .appAccountToken(...), and Apple returns it inside the signed transaction. So
 * the binding evidence is something only our server could have created, and the
 * unique index on that column means it can resolve to at most one account.
 *
 * ── WHERE THIS RUNS ───────────────────────────────────────────────────────
 *
 * Inside completeReconciliation's generation-fenced CAS transaction, between the
 * snapshot write and projection. A stale generation loses the CAS and never
 * reaches binding; a projection failure rolls a fresh binding back with it. The
 * binding is derived from the AUTHORITATIVE snapshot Apple's Server API returned,
 * never from a client-submitted payload.
 */

/**
 * Two credible owners for one subscription. Never resolved automatically.
 *
 * Reassigning a subscription is how one customer's paid access silently becomes
 * another's, so this parks for an operator exactly like a billing-rail conflict
 * rather than retrying on a ladder that cannot change the answer.
 */
export class AppleOwnershipConflictError extends Error {
  constructor(readonly reason: string) {
    super(`apple subscription ownership conflict: ${reason}`);
    this.name = 'AppleOwnershipConflictError';
  }
}

export type BindingOutcome =
  /** Already bound. Durable, and never silently reassigned. */
  | 'already-bound'
  /** Bound through the server-issued token in the authoritative snapshot. */
  | 'bound-by-token'
  /** Bound through the transitional OTI column — only when no token exists. */
  | 'bound-by-legacy-oti'
  /** Nobody could be established. The snapshot stands; no user is attached. */
  | 'unbound';

export interface BindingResult {
  outcome: BindingOutcome;
  userId: string | null;
}

const SELECT_SUBSCRIPTION_OWNER_SQL = `
SELECT "userId", "appAccountToken" FROM "AppleSubscription"
WHERE "environment" = ? AND "originalTransactionId" = ?
`.trim();

const SELECT_USER_BY_TOKEN_SQL = `
SELECT "id" FROM "User" WHERE "appleAppAccountToken" = ?
`.trim();

const SELECT_USER_BY_LEGACY_OTI_SQL = `
SELECT "id" FROM "User" WHERE "appleOriginalTransactionId" = ?
`.trim();

const BIND_SUBSCRIPTION_SQL = `
UPDATE "AppleSubscription" SET "userId" = ?, "updatedAt" = ?
WHERE "environment" = ? AND "originalTransactionId" = ? AND "userId" IS NULL
`.trim();

/**
 * Compatibility dual-write, Production only.
 *
 * Set ONLY when the column is NULL. Never overwritten: this is transitional
 * state that some legacy read paths still consult, and flipping it between a
 * user's historical original transaction ids would make those paths oscillate.
 * Durable AppleSubscription.userId is the authority; this is a shadow of it.
 */
const DUAL_WRITE_LEGACY_OTI_SQL = `
UPDATE "User" SET "appleOriginalTransactionId" = ?
WHERE "id" = ? AND "appleOriginalTransactionId" IS NULL
`.trim();

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * Resolve a server-issued token to its account.
 *
 * Returns null for a token we never issued. That is NOT a reason to look
 * elsewhere: an unregistered token means a client chose its own UUID, and the
 * correct outcome is that the purchase binds to nobody.
 */
export async function resolveTokenOwner(
  db: QueueClient,
  appAccountToken: string,
): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<{ id: unknown }>(SELECT_USER_BY_TOKEN_SQL, appAccountToken);
  return rows.length === 1 ? str(rows[0].id) : null;
}

/**
 * Establish ownership for a reconciled subscription.
 *
 * Must be called inside completeReconciliation's transaction, after
 * writeSnapshot and before projection.
 */
export async function bindSubscriptionOwner(
  tx: QueueClient,
  key: { environment: string; originalTransactionId: string },
  now: Date,
): Promise<BindingResult> {
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>>(
    SELECT_SUBSCRIPTION_OWNER_SQL, key.environment, key.originalTransactionId,
  );
  const row = rows[0];
  if (!row) return { outcome: 'unbound', userId: null };

  const existingUserId = str(row.userId);
  /**
   * The token from the AUTHORITATIVE snapshot — what Apple's Server API returned
   * and the reconciler verified — not from anything a client submitted.
   */
  const token = str(row.appAccountToken);
  const tokenOwner = token ? await resolveTokenOwner(tx, token) : null;

  if (existingUserId) {
    /**
     * Durable. The only thing that may happen here is a conflict: if Apple's own
     * state says this subscription carries user B's token while the row is bound
     * to user A, one of those facts is wrong and a machine cannot tell which.
     * Reassigning would move paid access between accounts on a guess.
     */
    if (tokenOwner && tokenOwner !== existingUserId) {
      throw new AppleOwnershipConflictError(
        'subscription is bound to one account while its verified appAccountToken belongs to another',
      );
    }

    /**
     * The token agrees with the durable binding — but the transitional column
     * may still name a third account for this same subscription. That state is
     * contradictory and a machine cannot pick a winner, so it is an operator
     * condition rather than something to accept silently just because the
     * binding itself looks settled.
     *
     * Only checked when a token is present. Without one there is nothing
     * authoritative to contradict, and durable AppleSubscription.userId simply
     * wins.
     */
    if (tokenOwner) {
      const legacyOwner = await legacyOtiOwner(tx, key.originalTransactionId);
      if (legacyOwner && legacyOwner !== existingUserId) {
        throw new AppleOwnershipConflictError(
          'bound subscription and the transitional appleOriginalTransactionId name different accounts',
        );
      }
    }

    return { outcome: 'already-bound', userId: existingUserId };
  }

  if (token) {
    /**
     * A token is present, so it decides — including when it decides nobody.
     *
     * The legacy OTI fallback is deliberately NOT consulted here. Falling back
     * would let an attacker who bought with an unregistered UUID land on
     * whatever account the transitional column happens to point at, which is
     * exactly the ownership-by-possession the token was introduced to remove.
     */
    if (!tokenOwner) return { outcome: 'unbound', userId: null };

    const legacyOwner = await legacyOtiOwner(tx, key.originalTransactionId);
    if (legacyOwner && legacyOwner !== tokenOwner) {
      throw new AppleOwnershipConflictError(
        'verified appAccountToken and the transitional appleOriginalTransactionId point to different accounts',
      );
    }

    await bind(tx, key, tokenOwner, now);
    return { outcome: 'bound-by-token', userId: tokenOwner };
  }

  /**
   * No token at all: a purchase made before purchase-context existed. Ownership
   * may only be INHERITED from a link that already exists — never created.
   */
  const legacyOwner = await legacyOtiOwner(tx, key.originalTransactionId);
  if (!legacyOwner) return { outcome: 'unbound', userId: null };

  await bind(tx, key, legacyOwner, now);
  return { outcome: 'bound-by-legacy-oti', userId: legacyOwner };
}

async function legacyOtiOwner(tx: QueueClient, originalTransactionId: string): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<{ id: unknown }>(
    SELECT_USER_BY_LEGACY_OTI_SQL, originalTransactionId,
  );
  return rows.length === 1 ? str(rows[0].id) : null;
}

async function bind(
  tx: QueueClient,
  key: { environment: string; originalTransactionId: string },
  userId: string,
  now: Date,
): Promise<void> {
  const changed = await tx.$executeRawUnsafe(
    BIND_SUBSCRIPTION_SQL, userId, now.toISOString(), key.environment, key.originalTransactionId,
  );
  /**
   * The WHERE carries `userId IS NULL`, so a concurrent binding cannot be
   * overwritten. Zero rows means someone bound it between our read and this
   * write; that is a conflict rather than something to retry over.
   */
  if (changed === 0) {
    throw new AppleOwnershipConflictError('subscription was bound concurrently by another writer');
  }

  // Sandbox may bind for testing and audit, but must never touch the
  // transitional column that Production read paths consult.
  if (key.environment === PRODUCTION_ENVIRONMENT) {
    await tx.$executeRawUnsafe(DUAL_WRITE_LEGACY_OTI_SQL, key.originalTransactionId, userId);
  }
}
