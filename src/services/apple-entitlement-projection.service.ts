import type { QueueClient } from './apple-reconciliation-queue.service';

/**
 * Apple entitlement projection.
 *
 * `User.plan` is a PROJECTION of persisted Apple facts, never a delta applied
 * from whatever event happened to arrive. That is the whole point: the legacy
 * path mutated entitlement directly from client-submitted transactions and
 * notification payloads, so the last message to arrive won regardless of what
 * Apple actually believed. Here the only positive authority is a reconciled
 * `AppleSubscription` snapshot.
 *
 * WHERE THIS RUNS IS LOAD-BEARING. The write happens inside the reconciler's
 * existing generation-fenced CAS transaction (see completeReconciliation), so a
 * correctly serialized snapshot can never be followed by an unserialized plan
 * update. A stale generation G1 that returns after G2 committed loses the CAS,
 * and the projection rolls back with it — it never gets to touch User.
 *
 * Recomputation, not event handling: nothing here knows about notification
 * types. The authoritative webhook intake (a later stage) will call the same
 * function after persisting a negative fact such as a revocation.
 */

/**
 * The only environment whose facts may project entitlement by default. A
 * Sandbox subscription must never mint real entitlement, and TestFlight is not
 * a signal that Sandbox is trustworthy.
 */
export const PRODUCTION_ENVIRONMENT = 'Production';

/**
 * The QA-only environment, admitted ONLY through the explicit allowlist below.
 * Never a synonym for "test mode" — see resolveProjectionEnvironment.
 */
export const SANDBOX_ENVIRONMENT = 'Sandbox';

/**
 * Server-side permission to project SANDBOX facts, for named users only.
 *
 * This exists so a disposable QA account can walk the complete
 * purchase -> backend authority -> plan -> unlock path before Production is the
 * first environment that path has ever run in. It is deliberately the narrowest
 * possible hole:
 *
 *   - `enabled` is a server env var, never a request, header, body field, JWS
 *     claim, appAccountToken, email or username. Nothing a client sends can
 *     reach this decision.
 *   - `userIds` holds server-side User UUIDs and defaults to EMPTY, which means
 *     nobody. There is no "empty means everyone" fallback and no
 *     "all Sandbox users" mode.
 *   - There is no NODE_ENV shortcut. TestFlight talks to the real production
 *     backend, so `NODE_ENV !== 'production'` would be both wrong and useless.
 */
export interface SandboxProjectionPolicy {
  enabled: boolean;
  userIds: ReadonlySet<string>;
}

/** The default in every environment: Sandbox projects for nobody. */
export const SANDBOX_PROJECTION_DISABLED: SandboxProjectionPolicy = {
  enabled: false,
  userIds: new Set<string>(),
};

/**
 * Parse the policy from raw environment variables. Pure, and fails CLOSED.
 *
 * `enabled` uses an exact `=== 'true'` match, so every other value — unset,
 * empty, `TRUE`, `1`, `yes`, `false`, whitespace, a typo — is false. A flag that
 * silently enabled on a malformed value would be the worst possible failure
 * here, so nothing is coerced.
 *
 * `userIds` trims each entry and drops empties, which makes unset, `''`,
 * `'   '`, `','` and `',,,'` all mean the same thing: nobody. Entries are NOT
 * normalised in any other way — no lowercasing, no email/username acceptance —
 * because the value is compared for exact equality against
 * `AppleSubscription.userId`, and a fuzzy match here would be an authorization
 * bug. A malformed entry simply never equals a real UUID.
 */
export function parseSandboxProjectionPolicy(
  env: Record<string, string | undefined>,
): SandboxProjectionPolicy {
  return {
    enabled: env.APPLE_SANDBOX_PROJECTION_ENABLED === 'true',
    userIds: new Set(
      (env.APPLE_SANDBOX_PROJECTION_USER_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  };
}

/**
 * Which environment's facts may project for this binding, or null for "none".
 *
 * The returned value is the environment the projection will READ FROM, which is
 * what keeps the two environments isolated: a Sandbox projection selects only
 * Sandbox rows and a Production projection selects only Production rows, so a
 * QA user holding both never mixes them into one entitlement decision.
 *
 * Every branch that is not explicitly Production or an allowlisted Sandbox
 * returns null, including an unrecognised environment string — an environment
 * Apple has not taught us about must not be assumed harmless.
 */
export function resolveProjectionEnvironment(
  environment: string,
  userId: string | null,
  policy: SandboxProjectionPolicy,
): string | null {
  if (environment === PRODUCTION_ENVIRONMENT) return PRODUCTION_ENVIRONMENT;
  if (environment !== SANDBOX_ENVIRONMENT) return null;
  if (!policy.enabled) return null;
  if (!userId) return null;
  return policy.userIds.has(userId) ? SANDBOX_ENVIRONMENT : null;
}

/** The durable marker meaning "Apple owns the currently projected plan". */
export const APPLE_PURCHASE_SOURCE = 'app_store';

/**
 * Paid tiers Apple may project. An unknown value is CORRUPT, not free.
 *
 * buildSnapshot already refuses unknown products, so reaching this check means
 * the persisted row itself is bad. Normalizing it to 'free' would silently
 * strip a paying customer's access, so it fails closed instead.
 */
const PAID_PLANS: ReadonlySet<string> = new Set(['pro', 'premium', 'elite']);

/** Statuses that block the other billing rail. Matches apple_subscription_rail_unique. */
const RAIL_BLOCKING: ReadonlySet<string> = new Set(['active', 'grace', 'billing_retry']);

/**
 * A user holds a blocking Apple rail AND a live Stripe subscription.
 *
 * This is an operator-action condition, not a transient database problem, so it
 * must not be retried every few seconds. The caller parks it durably; the
 * existing parked-job recovery requeues it once a human has resolved the
 * double rail.
 */
export class BillingRailConflictError extends Error {
  constructor(readonly userId: string, readonly stripeSubscriptionId: string) {
    super('user holds both a blocking Apple billing rail and a live Stripe subscription');
    this.name = 'BillingRailConflictError';
  }
}

/** Persisted Apple state is unusable for projection. Permanent until data is fixed. */
export class AppleProjectionDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleProjectionDataError';
  }
}

export interface AppleSubscriptionFacts {
  environment: string;
  originalTransactionId: string;
  userId: string | null;
  plan: string;
  status: string;
  expiresAt: Date | null;
  gracePeriodExpiresAt: Date | null;
  autoRenewStatus: boolean | null;
  currentTransactionId: string | null;
}

export interface EntitlementPredicates {
  isEntitled: boolean;
  mayAppleCollect: boolean;
  blocksOtherBillingRail: boolean;
}

/**
 * Entitled to paid access right now.
 *
 * Fails closed on time: a missing expiry does NOT grant, and equality with
 * `now` is no longer entitled (strict `>`). Treating a null expiry as
 * permanent access would be especially dangerous here — plan.middleware.ts
 * only downgrades when planExpiresAt is non-null, so a paid plan with a null
 * expiry is a subscription that never ends. Apple must never mint one.
 */
export function isEntitled(f: AppleSubscriptionFacts, now: Date): boolean {
  if (f.status === 'active') {
    return f.expiresAt !== null && f.expiresAt.getTime() > now.getTime();
  }
  if (f.status === 'grace') {
    return f.gracePeriodExpiresAt !== null && f.gracePeriodExpiresAt.getTime() > now.getTime();
  }
  return false;
}

/**
 * Apple may still charge this subscriber.
 *
 * Deliberately NOT the same question as entitlement. `billing_retry` grants no
 * access while Apple keeps attempting collection for up to 60 days, and an
 * `active` subscription with auto-renew OFF stays entitled through its expiry
 * while Apple will never charge again.
 */
export function mayAppleCollect(f: AppleSubscriptionFacts): boolean {
  if (f.status === 'grace' || f.status === 'billing_retry') return true;
  return f.status === 'active' && f.autoRenewStatus === true;
}

/**
 * Stripe signup must be refused.
 *
 * WIDER than entitlement on purpose: a user in billing retry receives nothing
 * today, but admitting them to Stripe risks double-billing the moment Apple's
 * retry succeeds. Purely a function of status — revocation of the current
 * transaction removes the GRANT (below) but does not free the rail, which is
 * the conservative direction in both cases.
 */
export function blocksOtherBillingRail(f: AppleSubscriptionFacts): boolean {
  return RAIL_BLOCKING.has(f.status);
}

/** All three predicates against ONE captured `now`. Never collapse them into one boolean. */
export function evaluateAppleEntitlement(f: AppleSubscriptionFacts, now: Date): EntitlementPredicates {
  return {
    isEntitled: isEntitled(f, now),
    mayAppleCollect: mayAppleCollect(f),
    blocksOtherBillingRail: blocksOtherBillingRail(f),
  };
}

/**
 * SQLite has no boolean type: Prisma stores Boolean as INTEGER 0/1, so a raw
 * read returns a number while a Prisma read returns a real boolean. Both reach
 * this code — the reconciler's tx is a Prisma client in production and a raw
 * libsql adapter under test — so normalize before the `=== true` comparison
 * that mayAppleCollect performs. An unrecognised value is null (unknown), not
 * false, so it can never be mistaken for a deliberate auto-renew-off.
 */
export function toBooleanOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === 'bigint') return v === 1n ? true : v === 0n ? false : null;
  if (typeof v === 'string') {
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  }
  return null;
}

/**
 * Timestamps are stored as ISO text (measured: Prisma's libsql adapter writes
 * `...Z` text for DateTime, and reads both `Z` and `+00:00` back as Dates).
 * Integers are tolerated because this database provably carries legacy epoch-ms
 * rows in DateTime columns. Anything unparseable becomes null, which fails
 * closed through isEntitled rather than granting on garbage.
 */
export function parseTimestampOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof v === 'bigint') { const d = new Date(Number(v)); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof v === 'string') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));

export function rowToFacts(row: Record<string, unknown>): AppleSubscriptionFacts {
  return {
    environment: str(row.environment) ?? '',
    originalTransactionId: str(row.originalTransactionId) ?? '',
    userId: str(row.userId),
    plan: str(row.plan) ?? '',
    status: str(row.status) ?? '',
    expiresAt: parseTimestampOrNull(row.expiresAt),
    gracePeriodExpiresAt: parseTimestampOrNull(row.gracePeriodExpiresAt),
    autoRenewStatus: toBooleanOrNull(row.autoRenewStatus),
    currentTransactionId: str(row.currentTransactionId),
  };
}

export const SELECT_SUBSCRIPTIONS_FOR_ENVIRONMENT_SQL = `
SELECT "environment", "originalTransactionId", "userId", "plan", "status",
       "expiresAt", "gracePeriodExpiresAt", "autoRenewStatus", "currentTransactionId"
FROM "AppleSubscription"
WHERE "userId" = ? AND "environment" = ?
`.trim();

/**
 * Existence only. Deliberately selects no columns and stops at one row: the
 * caller must not be able to make an entitlement decision out of this answer.
 */
export const SELECT_PRODUCTION_SUBSCRIPTION_EXISTS_SQL = `
SELECT 1 AS present
FROM "AppleSubscription"
WHERE "userId" = ? AND "environment" = ?
LIMIT 1
`.trim();

export const SELECT_TRANSACTION_REVOCATION_SQL = `
SELECT "revokedAt", "reversedAt"
FROM "AppleTransaction"
WHERE "environment" = ? AND "transactionId" = ?
`.trim();

export const SELECT_USER_BILLING_SQL = `
SELECT "plan", "planExpiresAt", "planStartedAt", "stripeSubscriptionId", "applePurchaseSource"
FROM "User"
WHERE "id" = ?
`.trim();

export const UPDATE_USER_PROJECTION_SQL = `
UPDATE "User"
SET "plan" = ?, "planExpiresAt" = ?, "planStartedAt" = ?, "applePurchaseSource" = ?
WHERE "id" = ?
`.trim();

export type AppleProjectionAction =
  /** No bound Production row, or nothing Apple owns to change. User untouched. */
  | 'no-op'
  /** Paid access granted or refreshed from a reconciled snapshot. */
  | 'granted'
  /** Apple-owned paid access removed (expiry, revocation, retry, or loss of entitlement). */
  | 'downgraded'
  /** Not entitled, but the projected plan belongs to another rail. Deliberately untouched. */
  | 'foreign-plan-preserved';

export interface AppleProjectionResult {
  action: AppleProjectionAction;
  /** The row entitlement was computed from, if any. */
  predicates: EntitlementPredicates | null;
  plan: string | null;
  planExpiresAt: Date | null;
  /** True when the current transaction carries an unreversed revocation. */
  revokedCurrentTransaction: boolean;
}

/**
 * Does this user have ANY Production Apple subscription row?
 *
 * Any status counts, expired included. A user who has ever held a Production
 * Apple subscription is not a disposable QA account, and the Sandbox hatch must
 * not touch their plan again.
 *
 * Existence only, by design — it returns a boolean and never surfaces plan,
 * status or expiry, so a Production fact can never leak into a Sandbox
 * entitlement calculation.
 */
export async function userHasProductionAppleSubscription(
  db: QueueClient,
  userId: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>>(
    SELECT_PRODUCTION_SUBSCRIPTION_EXISTS_SQL, userId, PRODUCTION_ENVIRONMENT,
  );
  return rows.length > 0;
}

/**
 * Recompute `User.plan` from persisted Apple facts.
 *
 * MUST be called inside completeReconciliation's transaction, after
 * writeSnapshot, so the snapshot and the projection commit or roll back as one.
 *
 * @param tx  the CAS transaction — NOT a fresh client
 * @param now one captured instant for the entire projection
 */
export async function projectAppleEntitlementForUser(
  tx: QueueClient,
  userId: string,
  now: Date,
  environment: string = PRODUCTION_ENVIRONMENT,
): Promise<AppleProjectionResult> {
  /**
   * PRODUCTION-PRESENCE VETO.
   *
   * `User.plan` and `User.applePurchaseSource` are global. `applePurchaseSource`
   * records only 'app_store' — it does NOT record which environment established
   * the plan. So reading one environment's rows is not on its own enough to keep
   * the environments isolated: a Sandbox pass that finds an expired Sandbox row
   * would see `applePurchaseSource = 'app_store'`, believe Apple owns the plan,
   * and downgrade an entitlement Production had granted.
   *
   * The guard: if the user has ANY Production AppleSubscription row — any
   * status, including expired — a non-Production projection mutates nothing.
   * Production permanently outranks the QA hatch, which is only ever meant for
   * disposable accounts with no Production Apple history at all.
   *
   * This is an ISOLATION check, not a second entitlement calculation. It asks
   * one question — does a Production row exist — and never reads Production
   * status, plan or expiry, so no Production fact can influence what Sandbox
   * would have granted. Sandbox facts still persist, reconcile and bind; only
   * the User.plan write is withheld.
   *
   * It lives here rather than at the reconciler's gate so it cannot be bypassed
   * by a future caller — the authoritative webhook intake will call this same
   * function. It runs on `tx`, the generation-fenced CAS transaction, so there
   * is no check/write race with a concurrent Production reconciliation.
   */
  if (environment !== PRODUCTION_ENVIRONMENT
      && await userHasProductionAppleSubscription(tx, userId)) {
    return {
      action: 'no-op', predicates: null, plan: null,
      planExpiresAt: null, revokedCurrentTransaction: false,
    };
  }

  const rows = await tx.$queryRawUnsafe<Record<string, unknown>>(
    SELECT_SUBSCRIPTIONS_FOR_ENVIRONMENT_SQL, userId, environment,
  );
  const subs = rows.map(rowToFacts);

  /**
   * At most one row can be rail-blocking per user — apple_subscription_rail_unique
   * enforces exactly this predicate at the database level. Taking the first is
   * therefore deterministic, not a silent "pick one of several".
   */
  const blocking = subs.find((s) => blocksOtherBillingRail(s)) ?? null;

  const userRows = await tx.$queryRawUnsafe<Record<string, unknown>>(SELECT_USER_BILLING_SQL, userId);
  const user = userRows[0];
  if (!user) {
    // The binding points at a user that no longer exists. Nothing to project.
    return { action: 'no-op', predicates: null, plan: null, planExpiresAt: null, revokedCurrentTransaction: false };
  }

  const currentPlan = str(user.plan) ?? 'free';
  const currentStartedAt = parseTimestampOrNull(user.planStartedAt);
  const stripeSubscriptionId = str(user.stripeSubscriptionId);
  const appleOwnsCurrentPlan = str(user.applePurchaseSource) === APPLE_PURCHASE_SOURCE;

  /**
   * Stripe -> Apple exclusion, conservative by design.
   *
   * A non-null stripeSubscriptionId means the Stripe rail is still live even
   * when User.plan already reads 'free' — the payment-failure handler
   * downgrades the plan but leaves the subscription id in place. Apple must not
   * overwrite that rail, and must not silently pick a winner.
   */
  if (blocking && stripeSubscriptionId) {
    throw new BillingRailConflictError(userId, stripeSubscriptionId);
  }

  const predicates = blocking ? evaluateAppleEntitlement(blocking, now) : null;

  /**
   * Transaction-scoped revocation is an ADDITIONAL no-grant guard.
   *
   * Scoped to the snapshot's own currentTransactionId so a historical revoked
   * transaction cannot poison a current one. REFUND_FULL, REFUND_PRORATED and
   * FAMILY_REVOKE are identical here, and revocationPercentage is not an
   * entitlement input — a 50%-refunded subscription is still refunded.
   * A reversal only lifts the guard; it does not itself grant anything.
   */
  let revoked = false;
  if (blocking?.currentTransactionId) {
    const txRows = await tx.$queryRawUnsafe<Record<string, unknown>>(
      SELECT_TRANSACTION_REVOCATION_SQL, blocking.environment, blocking.currentTransactionId,
    );
    const t = txRows[0];
    if (t) revoked = parseTimestampOrNull(t.revokedAt) !== null && parseTimestampOrNull(t.reversedAt) === null;
  }

  const grants = Boolean(blocking && predicates?.isEntitled && !revoked);

  if (grants && blocking) {
    if (!PAID_PLANS.has(blocking.plan)) {
      throw new AppleProjectionDataError(`unknown Apple plan in persisted snapshot: ${blocking.plan}`);
    }
    const expiry = blocking.status === 'grace' ? blocking.gracePeriodExpiresAt : blocking.expiresAt;
    if (!expiry) {
      // isEntitled already proved this non-null; belt and braces, because a
      // paid plan with a null expiry never expires.
      throw new AppleProjectionDataError('entitled Apple subscription has no expiry');
    }

    /**
     * Renewal of the same tier preserves planStartedAt — it is user-facing
     * ("member since") and surfaced through social.controller.ts. An actual
     * tier change, or a transition into Apple from free/another rail, restarts
     * it.
     */
    const sameAppleTier = appleOwnsCurrentPlan && currentPlan === blocking.plan && currentStartedAt !== null;
    const startedAt = sameAppleTier ? currentStartedAt : now;

    await tx.$executeRawUnsafe(
      UPDATE_USER_PROJECTION_SQL,
      blocking.plan,
      expiry.toISOString(),
      startedAt.toISOString(),
      APPLE_PURCHASE_SOURCE,
      userId,
    );
    return {
      action: 'granted', predicates, plan: blocking.plan,
      planExpiresAt: expiry, revokedCurrentTransaction: revoked,
    };
  }

  /**
   * No current Apple entitlement.
   *
   * Apple may only clear a plan it owns. A stale Apple expiry must never wipe
   * out a legitimate Stripe plan, so without the ownership marker this is a
   * no-op rather than a downgrade.
   */
  if (!appleOwnsCurrentPlan) {
    return {
      action: currentPlan === 'free' ? 'no-op' : 'foreign-plan-preserved',
      predicates, plan: null, planExpiresAt: null, revokedCurrentTransaction: revoked,
    };
  }

  if (currentPlan === 'free' && user.planExpiresAt === null) {
    return { action: 'no-op', predicates, plan: null, planExpiresAt: null, revokedCurrentTransaction: revoked };
  }

  /**
   * Downgrade, preserving BOTH durable markers:
   *   applePurchaseSource stays 'app_store' — clearing it on expiry/revocation
   *     is failure mode B in the frozen design: it destroys the ownership fact
   *     that lets a later renewal be recognised as Apple's.
   *   planStartedAt is not erased — losing entitlement does not rewrite history.
   */
  await tx.$executeRawUnsafe(
    UPDATE_USER_PROJECTION_SQL,
    'free',
    null,
    currentStartedAt ? currentStartedAt.toISOString() : null,
    APPLE_PURCHASE_SOURCE,
    userId,
  );
  return { action: 'downgraded', predicates, plan: 'free', planExpiresAt: null, revokedCurrentTransaction: revoked };
}

/**
 * The user's blocking Production Apple rail, if any.
 *
 * Used by the Stripe side, which must ask Apple's authoritative table and not
 * User.plan: a user in billing_retry reads as 'free' while Apple may still
 * collect, and that user must still be refused a second rail.
 *
 * Deliberately queries AppleSubscription, never User.appleOriginalTransactionId
 * — that column is transitional compatibility state and must not become the
 * rail-blocking authority again.
 */
export async function findBlockingAppleRail(
  db: QueueClient,
  userId: string,
): Promise<AppleSubscriptionFacts | null> {
  const rows = await db.$queryRawUnsafe<Record<string, unknown>>(
    SELECT_SUBSCRIPTIONS_FOR_ENVIRONMENT_SQL, userId, PRODUCTION_ENVIRONMENT,
  );
  return rows.map(rowToFacts).find((s) => blocksOtherBillingRail(s)) ?? null;
}

/** True when a second billing rail must be refused for this user. */
export async function userHasBlockingAppleRail(db: QueueClient, userId: string): Promise<boolean> {
  return (await findBlockingAppleRail(db, userId)) !== null;
}

/**
 * Downgrade a plan ONLY if Apple does not currently own it.
 *
 * The ownership test is part of the WHERE clause, not a value read earlier and
 * trusted later. That distinction is the whole point: a Stripe webhook handler
 * that reads `applePurchaseSource`, then writes, can be overtaken between the
 * two by an Apple reconciliation that grants and claims the plan — and would
 * then free a plan Apple had just paid-up. Re-reading immediately before the
 * write only shrinks that window; deciding at the write closes it.
 *
 * NULL is spelled out rather than left to `<>`. In SQL, `applePurchaseSource <>
 * 'app_store'` is NULL — and therefore not true — for every row where the column
 * is NULL, which is most of them. Written the obvious way this guard would
 * silently skip every ordinary Stripe user.
 *
 * planStartedAt uses COALESCE so a caller that supplies one writes it and a
 * caller that does not leaves history alone.
 *
 * @returns true if the row was actually changed.
 */
export const DOWNGRADE_IF_NOT_APPLE_OWNED_SQL = `
UPDATE "User"
SET "plan" = ?, "planExpiresAt" = ?, "planStartedAt" = COALESCE(?, "planStartedAt")
WHERE "id" = ?
  AND ("applePurchaseSource" IS NULL OR "applePurchaseSource" <> ?)
`.trim();

export async function downgradeIfNotAppleOwned(
  db: QueueClient,
  userId: string,
  plan: string,
  planExpiresAt: Date | null,
  planStartedAt: Date | null,
): Promise<boolean> {
  const changed = await db.$executeRawUnsafe(
    DOWNGRADE_IF_NOT_APPLE_OWNED_SQL,
    plan,
    planExpiresAt ? planExpiresAt.toISOString() : null,
    planStartedAt ? planStartedAt.toISOString() : null,
    userId,
    APPLE_PURCHASE_SOURCE,
  );
  return changed > 0;
}
