import prisma from '../utils/prisma';
import jwt, { SignOptions, Secret, TokenExpiredError } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';
import { config } from '../config';
import { JwtPayload, LoginResponse, MfaChallengeResponse, OTP_PURPOSE } from '../types/auth';
import { hasMfaEnabled, createMfaChallenge, getEnabledMethods, getMaskedEmail } from './mfa.service';
import { sendEmailVerification, sendPasswordResetEmail, sendUsernameReminderEmail, sendEmailChangeVerification, sendEmailChangedNotice } from './email.service';



export const CURRENT_POLICY_VERSION = '1.0';
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
// Was 30s. Bumped to 5 min so users mid-rotation across a deploy (which wipes
// the in-memory cache) still have a wide window for the DB-backed fallback to
// recover them — see RefreshRotationCache.
export const REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS = 5 * 60 * 1000;

type RefreshRotationResult = { accessToken: string; refreshToken: string; payload: JwtPayload };
type PendingRefreshRotationCacheEntry = {
  status: 'pending';
  userId: string;
  family: string;
  createdAtMs: number;
  settled: Promise<RefreshRotationResult | null>;
  resolve: (value: RefreshRotationResult | null) => void;
  reject: (reason?: unknown) => void;
};
type SettledRefreshRotationCacheEntry = {
  status: 'settled';
  userId: string;
  family: string;
  createdAtMs: number;
  payload: RefreshRotationResult;
  consumed: boolean;
};
type RefreshRotationCacheEntry = PendingRefreshRotationCacheEntry | SettledRefreshRotationCacheEntry;
// Process-local. Startup asserts a manual single-replica guard when configured.
// If we ever run multiple replicas, replace this with shared storage.
const recentRefreshRotations = new Map<string, RefreshRotationCacheEntry>();

/** Hash a refresh token for storage — raw token is only returned to the client. */
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
const EMAIL_VERIFY_MAX_ATTEMPTS = 5;
const EMAIL_RESEND_LIMIT_PER_HOUR = 3;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR = 3;
const EMAIL_CHANGE_MAX_ATTEMPTS = 5;
const EMAIL_CHANGE_REQUEST_LIMIT_PER_HOUR = 3;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateEmailOtpCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function isWithinRefreshGraceWindow(revokedAt: Date | null | undefined, nowMs: number): boolean {
  if (!revokedAt) return false;
  return nowMs - revokedAt.getTime() <= REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS;
}

function pruneRecentRefreshRotations(nowMs = Date.now()): void {
  for (const [tokenHash, entry] of recentRefreshRotations.entries()) {
    if (nowMs - entry.createdAtMs > REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS) {
      recentRefreshRotations.delete(tokenHash);
    }
  }
}

function rememberPendingRefreshRotation(
  oldTokenHash: string,
  userId: string,
  family: string
): PendingRefreshRotationCacheEntry {
  const nowMs = Date.now();
  let resolve!: (value: RefreshRotationResult | null) => void;
  let reject!: (reason?: unknown) => void;
  const settled = new Promise<RefreshRotationResult | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const entry: PendingRefreshRotationCacheEntry = {
    status: 'pending',
    userId,
    family,
    createdAtMs: nowMs,
    settled,
    resolve,
    reject,
  };

  recentRefreshRotations.set(oldTokenHash, entry);
  pruneRecentRefreshRotations(nowMs);
  return entry;
}

function settleRefreshRotation(
  oldTokenHash: string,
  pending: PendingRefreshRotationCacheEntry,
  payload: RefreshRotationResult
): void {
  recentRefreshRotations.set(oldTokenHash, {
    status: 'settled',
    userId: pending.userId,
    family: pending.family,
    createdAtMs: pending.createdAtMs,
    payload,
    consumed: false,
  });
  pending.resolve(payload);
  // Mirror the settled rotation to the DB so a concurrent refresh that arrives
  // AFTER a redeploy (in-memory cache empty) can still find it. Fire-and-forget
  // — must never block the rotation response.
  persistSettledRotationToDB(oldTokenHash, payload, pending.userId, pending.family).catch(() => {
    // non-fatal; in-memory cache still satisfies same-process concurrent requests
  });
}

/**
 * Derive a 32-byte AES key from JWT_SECRET. Using a labeled domain separator so
 * the same secret can't be misused as both signing key and KEK without intent.
 */
function deriveRotationCacheKey(): Buffer {
  return crypto.createHash('sha256').update(config.jwtSecret).update('rotation-cache:v1').digest();
}

/** AES-256-GCM encrypt a refresh token. Returns base64(iv || authTag || ciphertext). */
function encryptRotationToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveRotationCacheKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Inverse of encryptRotationToken. Returns null on tamper/corruption. */
function decryptRotationToken(encoded: string): string | null {
  try {
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveRotationCacheKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Throttle the opportunistic cleanup of expired rotation-cache rows. SQLite is
// single-writer; without throttling, every settled rotation under high QPS
// would queue a deleteMany, contending for the write lock.
let lastRotationCacheCleanupMs = 0;
const ROTATION_CACHE_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Mirror a settled rotation to the DB. The plaintext refresh token is
 * encrypted at rest with a key derived from JWT_SECRET, so DB backups /
 * replicas don't carry usable tokens.
 */
async function persistSettledRotationToDB(
  oldTokenHash: string,
  payload: RefreshRotationResult,
  userId: string,
  family: string
): Promise<void> {
  const cipher = encryptRotationToken(payload.refreshToken);
  await prisma.refreshRotationCache.upsert({
    where: { oldTokenHash },
    create: {
      oldTokenHash,
      newTokenCipher: cipher,
      payloadJson: JSON.stringify(payload.payload),
      userId,
      family,
      consumed: false,
    },
    update: {
      newTokenCipher: cipher,
      payloadJson: JSON.stringify(payload.payload),
      userId,
      family,
      consumed: false,
      createdAt: new Date(),
    },
  });
  // Throttled opportunistic cleanup of rows older than 2 grace windows.
  const nowMs = Date.now();
  if (nowMs - lastRotationCacheCleanupMs >= ROTATION_CACHE_CLEANUP_INTERVAL_MS) {
    lastRotationCacheCleanupMs = nowMs;
    const cutoff = new Date(nowMs - REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS * 2);
    prisma.refreshRotationCache
      .deleteMany({ where: { createdAt: { lt: cutoff } } })
      .catch((err) => {
        console.warn('[rotation-cache] cleanup failed:', err instanceof Error ? err.message : String(err));
      });
  }
}

/**
 * DB-backed fallback for `recoverRecentRefreshRotation` when the in-memory
 * cache misses (e.g. after a redeploy). Verifies the cached row is for the
 * correct user/family, not consumed, within the grace window, AND that an
 * active sibling refresh token still exists in the family. Marks the row
 * consumed on success to prevent unbounded replay.
 */
async function recoverRefreshRotationFromDB(
  oldTokenHash: string,
  userId: string,
  family: string,
  payload: JwtPayload
): Promise<RefreshRotationResult | null> {
  const row = await prisma.refreshRotationCache.findUnique({ where: { oldTokenHash } });
  if (!row) return null;
  if (row.userId !== userId || row.family !== family) return null;
  if (row.consumed) return null;
  const ageMs = Date.now() - row.createdAt.getTime();
  if (ageMs > REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS) return null;

  // Belt and suspenders: confirm there's still an active token in the family.
  // If the family has been fully revoked (e.g., changePassword/resetPassword),
  // we should NOT resurrect the session.
  const activeFamilyToken = await prisma.refreshToken.findFirst({
    where: { userId, family, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (!activeFamilyToken) return null;

  // Atomic consume: only one concurrent request wins.
  const claim = await prisma.refreshRotationCache.updateMany({
    where: { id: row.id, consumed: false },
    data: { consumed: true },
  });
  if (claim.count === 0) return null;

  const plaintext = decryptRotationToken(row.newTokenCipher);
  if (!plaintext) {
    // Decryption failure means the row was written under a different secret
    // or got corrupted — refuse to resurrect rather than handing back garbage.
    return null;
  }

  return {
    accessToken: generateAccessToken(payload),
    refreshToken: plaintext,
    payload,
  };
}

function clearPendingRefreshRotation(oldTokenHash: string, pending: PendingRefreshRotationCacheEntry): void {
  const current = recentRefreshRotations.get(oldTokenHash);
  if (current === pending) {
    recentRefreshRotations.delete(oldTokenHash);
  }
  pending.resolve(null);
}

function invalidateRecentRefreshRotations(params: { userId?: string; family?: string }): void {
  const { userId, family } = params;
  if (!userId && !family) return;

  for (const [tokenHash, entry] of recentRefreshRotations.entries()) {
    const matchesUser = !!userId && entry.userId === userId;
    const matchesFamily = !!family && entry.family === family;
    if (matchesUser || matchesFamily) {
      recentRefreshRotations.delete(tokenHash);
    }
  }
  // Mirror invalidation to the DB. Non-fatal on failure but logged — a silent
  // swallow could let a row persist that another replica then resurrects.
  const where: Record<string, string> = {};
  if (userId) where.userId = userId;
  if (family) where.family = family;
  prisma.refreshRotationCache.deleteMany({ where }).catch((err) => {
    console.warn('[rotation-cache] invalidate mirror failed:', err instanceof Error ? err.message : String(err));
  });
}

async function recoverRecentRefreshRotation(
  oldTokenHash: string,
  userId: string,
  family: string,
  payload: JwtPayload
): Promise<RefreshRotationResult | null> {
  const cached = recentRefreshRotations.get(oldTokenHash);
  if (!cached) {
    // In-memory cache miss (typical after a redeploy). Fall through to the
    // DB-backed cache so cross-deploy rotation races don't kill sessions.
    return recoverRefreshRotationFromDB(oldTokenHash, userId, family, payload);
  }
  if (cached.userId !== userId || cached.family !== family) return null;
  if (Date.now() - cached.createdAtMs > REFRESH_TOKEN_ROTATION_GRACE_WINDOW_MS) {
    recentRefreshRotations.delete(oldTokenHash);
    return null;
  }

  if (cached.status === 'pending') {
    try {
      const resolved = await Promise.race<RefreshRotationResult | null>([
        cached.settled,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (!resolved) {
        return null;
      }
      return {
        accessToken: generateAccessToken(payload),
        refreshToken: resolved.refreshToken,
        payload,
      };
    } catch {
      return null;
    }
  }

  if (cached.consumed) {
    recentRefreshRotations.delete(oldTokenHash);
    return null;
  }

  const activeFamilyToken = await prisma.refreshToken.findFirst({
    where: {
      userId,
      family,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!activeFamilyToken) {
    recentRefreshRotations.delete(oldTokenHash);
    return null;
  }

  cached.consumed = true;
  // Mirror the consume to the DB row (if any) so a subsequent recover
  // attempt against the same oldTokenHash on another container after a
  // redeploy can't replay it again. Fire-and-forget; the in-memory
  // consume is the source of truth for same-process protection.
  prisma.refreshRotationCache
    .updateMany({ where: { oldTokenHash, consumed: false }, data: { consumed: true } })
    .catch((err) => {
      console.warn('[rotation-cache] mirror-consume failed:', err instanceof Error ? err.message : String(err));
    });

  return {
    accessToken: generateAccessToken(payload),
    refreshToken: cached.payload.refreshToken,
    payload,
  };
}

async function recoverRecentRefreshRotationWithRetry(
  oldTokenHash: string,
  userId: string,
  family: string,
  payload: JwtPayload,
  timeoutMs = 100,
  pollIntervalMs = 10
): Promise<RefreshRotationResult | null> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const recovered = await recoverRecentRefreshRotation(oldTokenHash, userId, family, payload);
    if (recovered) {
      return recovered;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function issueEmailVerificationCode(userId: string, email: string): Promise<void> {
  const code = generateEmailOtpCode();
  const codeHash = await bcrypt.hash(code, config.bcryptOtpSaltRounds);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  // Only supersede prior codes of the SAME purpose — a verification resend
  // must not invalidate a pending password-reset code (and vice versa).
  await prisma.emailOtpCode.updateMany({
    where: { userId, purpose: OTP_PURPOSE.EMAIL_VERIFICATION, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt, purpose: OTP_PURPOSE.EMAIL_VERIFICATION },
  });

  try {
    await sendEmailVerification(email, code);
  } catch {
    console.error('Email verification send failed');
  }
}

async function issuePasswordResetCode(userId: string, email: string): Promise<void> {
  const code = generateEmailOtpCode();
  const codeHash = await bcrypt.hash(code, config.bcryptOtpSaltRounds);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  await prisma.emailOtpCode.updateMany({
    where: { userId, purpose: OTP_PURPOSE.PASSWORD_RESET, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.emailOtpCode.create({
    data: { userId, codeHash, expiresAt, purpose: OTP_PURPOSE.PASSWORD_RESET },
  });

  try {
    await sendPasswordResetEmail(email, code);
  } catch {
    console.error('Password reset send failed');
  }
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.bcryptSaltRounds);
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a short-lived access token (15 minutes by default)
 */
export function generateAccessToken(payload: JwtPayload): string {
  const secret: Secret = config.jwtSecret;
  // 15 minutes in seconds
  const options: SignOptions = { expiresIn: 15 * 60 };
  return jwt.sign(payload, secret, options);
}

/**
 * @deprecated Use generateAccessToken() for short-lived (15m) access tokens
 * paired with refresh tokens. This function exists only for test compatibility.
 */
export function generateToken(payload: JwtPayload): string {
  const secret: Secret = config.jwtSecret;
  const options: SignOptions = { expiresIn: 60 * 60 * 24 * 7 };
  return jwt.sign(payload, secret, options);
}

/**
 * Generate a cryptographically random refresh token and store it in the database
 */
export async function generateRefreshToken(userId: string, family?: string): Promise<string> {
  const rawToken = crypto.randomBytes(64).toString('hex');
  const tokenHash = hashRefreshToken(rawToken);
  const tokenFamily = family ?? crypto.randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + config.refreshTokenExpiresInDays);

  await prisma.refreshToken.create({
    data: { token: tokenHash, userId, family: tokenFamily, expiresAt },
  });

  return rawToken;
}

/**
 * Detection telemetry for probable refresh-token theft. Called when a refresh
 * token that has already been rotated/revoked is presented and cannot be
 * legitimately recovered, forcing a family-wide revocation. Logging/telemetry
 * only — the caller still performs the revoke. `reason` distinguishes the two
 * call sites for triage.
 */
function reportRefreshTokenReuse(
  userId: string,
  family: string,
  reason: 'revoked_token_reused' | 'rotated_token_replayed'
): void {
  console.warn('[auth] refresh token reuse detected — revoking family', { userId, family, reason });
  Sentry.captureException(new Error('refresh_token_reuse_detected'), {
    tags: { component: 'auth_refresh', reason },
    extra: { userId, family },
  });
}

/**
 * Rotate a refresh token: revoke the old one and issue a new one.
 * Returns null if the provided token is invalid, expired, or already revoked.
 */
export async function rotateRefreshToken(
  oldToken: string
): Promise<RefreshRotationResult | null> {
  const oldTokenHash = hashRefreshToken(oldToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { token: oldTokenHash },
    include: { user: { select: { id: true, username: true, plan: true, planExpiresAt: true, emailVerified: true } } },
  });

  const now = new Date();
  const nowMs = now.getTime();

  if (!stored || stored.expiresAt < now) {
    return null;
  }
  const tokenFamily = stored.family ?? stored.id;

  const buildPayload = (): JwtPayload => ({
    userId: stored.user.id,
    username: stored.user.username,
    plan: stored.user.plan,
    planExpiresAt: stored.user.planExpiresAt ? stored.user.planExpiresAt.toISOString() : null,
    emailVerified: stored.user.emailVerified ?? false,
  });
  const payload = buildPayload();

  if (stored.revokedAt) {
    // Loser of a refresh race can recover within the grace window via the
    // rotation cache (in-memory + DB-backed fallback for cross-deploy recovery).
    // Tradeoff: a stolen, already-rotated refresh token can yield one more
    // access token plus the same replacement refresh token during that window.
    // Acceptable for cross-tab UX; outside the window we revoke the family.
    if (isWithinRefreshGraceWindow(stored.revokedAt, nowMs)) {
      const recovered = await recoverRecentRefreshRotation(oldTokenHash, stored.userId, tokenFamily, payload);
      if (recovered) {
        return recovered;
      }
    }

    // Recovery failed on an already-revoked token (replay outside the grace
    // window, or a stolen already-rotated token). Treat as probable token
    // theft and revoke the whole family. Emit telemetry so this isn't silent.
    reportRefreshTokenReuse(stored.userId, tokenFamily, 'revoked_token_reused');
    invalidateRecentRefreshRotations({ userId: stored.userId, family: tokenFamily });
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, family: tokenFamily, revokedAt: null },
      data: { revokedAt: now },
    });
    return null;
  }

  // Atomically revoke the old token — only one concurrent request succeeds
  const revoked = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: now },
  });

  if (revoked.count === 0) {
    if (stored.expiresAt >= now) {
      const recovered = await recoverRecentRefreshRotationWithRetry(
        oldTokenHash,
        stored.userId,
        tokenFamily,
        payload
      );
      if (recovered) {
        return recovered;
      }
    }

    // We lost the atomic revoke race but couldn't recover the sibling rotation
    // either — the token was already consumed and isn't a legitimate concurrent
    // refresh. Treat as probable replay/theft and revoke the family, with telemetry.
    reportRefreshTokenReuse(stored.userId, tokenFamily, 'rotated_token_replayed');
    invalidateRecentRefreshRotations({ userId: stored.userId, family: tokenFamily });
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, family: tokenFamily, revokedAt: null },
      data: { revokedAt: now },
    });
    return null;
  }

  const pendingRotation = rememberPendingRefreshRotation(oldTokenHash, stored.userId, tokenFamily);

  try {
    const accessToken = generateAccessToken(payload);
    const refreshToken = await generateRefreshToken(stored.userId, tokenFamily);
    const result = { accessToken, refreshToken, payload };
    settleRefreshRotation(oldTokenHash, pendingRotation, result);
    return result;
  } catch (error) {
    clearPendingRefreshRotation(oldTokenHash, pendingRotation);
    throw error;
  }
}

/**
 * Revoke a single refresh token family (e.g., on logout — only affects current device)
 */
export async function revokeRefreshTokenFamily(refreshTokenValue: string): Promise<void> {
  const tokenHash = hashRefreshToken(refreshTokenValue);
  const stored = await prisma.refreshToken.findUnique({
    where: { token: tokenHash },
    select: { userId: true, family: true, id: true },
  });
  if (!stored) return;

  const family = stored.family ?? stored.id;
  invalidateRecentRefreshRotations({ userId: stored.userId, family });
  await prisma.refreshToken.updateMany({
    where: { userId: stored.userId, family, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke all refresh tokens for a user (e.g., on password change)
 */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  invalidateRecentRefreshRotations({ userId });
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
    return isAccessTokenPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * A genuine access token ALWAYS carries a non-empty string `userId` and never a
 * `purpose` claim. Reject anything else so a cryptographically-valid but
 * non-access token (e.g. a purpose-scoped signup token that happened to be
 * signed with the same key) can never be replayed as a session — which would
 * authenticate as userId:undefined and collapse Prisma tenant scoping to `where:{}`.
 */
function isAccessTokenPayload(payload: unknown): payload is JwtPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.userId === 'string' && p.userId.length > 0 && p.purpose === undefined;
}

/**
 * Verify a token and distinguish between expired and invalid.
 * Returns { payload, expired } where payload is null if truly invalid.
 */
export function verifyTokenDetailed(token: string): { payload: JwtPayload | null; expired: boolean } {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload;
    // Reject valid-signature tokens that are not access tokens (e.g. a signup
    // token). Without this, requireAuth/optionalAuth would set req.user to a
    // userId-less payload and every `where: { userId }` query would go unscoped.
    if (!isAccessTokenPayload(payload)) return { payload: null, expired: false };
    return { payload, expired: false };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Decode without verifying expiry to get the payload
      const decoded = jwt.decode(token) as JwtPayload | null;
      // Same guard on the expiry path — never surface a non-access payload.
      if (!isAccessTokenPayload(decoded)) return { payload: null, expired: false };
      return { payload: decoded, expired: true };
    }
    return { payload: null, expired: false };
  }
}

/**
 * Login with username and password.
 * Returns LoginResponse if no MFA, MfaChallengeResponse if MFA enabled, or null if invalid credentials.
 */
export async function loginWithPassword(
  username: string,
  password: string
): Promise<LoginResponse | MfaChallengeResponse | { error: string } | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      emailVerified: true,
      passwordHash: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      plan: true,
      planExpiresAt: true,
    },
  } as any) as {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    emailVerified: boolean;
    passwordHash: string | null;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
    plan: string;
    planExpiresAt: Date | null;
  } | null;

  if (!user) {
    return null;
  }

  // Check if user has a password set
  if (!user.passwordHash) {
    return null;
  }

  // Account lockout: return null (same as invalid credentials) to avoid leaking username existence
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return null;
  }

  // If lock has expired, reset attempts before checking password
  const effectiveAttempts = (user.lockedUntil && user.lockedUntil <= new Date()) ? 0 : user.failedLoginAttempts;

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    const nextFailedLoginAttempts = effectiveAttempts + 1;
    const lockoutThreshold = 10;
    const lockoutDurationMs = 30 * 60 * 1000;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: nextFailedLoginAttempts,
        lockedUntil: nextFailedLoginAttempts >= lockoutThreshold
          ? new Date(Date.now() + lockoutDurationMs)
          : null,
      },
    } as any);

    return null;
  }

  if (user.failedLoginAttempts !== 0 || user.lockedUntil !== null) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    } as any);
  }

  // Check if MFA is enabled — if so, return a challenge instead of tokens
  const mfaEnabled = await hasMfaEnabled(user.id);
  if (mfaEnabled) {
    const challengeToken = await createMfaChallenge(user.id);
    const methods = await getEnabledMethods(user.id);
    const maskedEmail = await getMaskedEmail(user.id);
    return {
      mfaRequired: true,
      challengeToken,
      methods,
      maskedEmail,
    };
  }

  const token = generateAccessToken({
    userId: user.id,
    username: user.username,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
    emailVerified: user.emailVerified ?? false,
  });
  const refreshToken = await generateRefreshToken(user.id);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
  };
}

/**
 * Set password for a user who doesn't have one yet (migration path only).
 * Rejects if user already has a password — use changePassword() instead.
 */
export async function setPassword(username: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);

  // Atomic: only update if passwordHash is currently null
  const result = await prisma.user.updateMany({
    where: { username, passwordHash: null },
    data: { passwordHash },
  });

  return result.count === 1;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, email: true, emailVerified: true, plan: true, planExpiresAt: true, createdAt: true },
  });
}

/**
 * Check if a user has a password set
 */
export async function hasPassword(username: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { passwordHash: true },
  });
  return !!user?.passwordHash;
}

/**
 * Change password for authenticated user (requires current password verification)
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });

  if (!user || !user.passwordHash) {
    return { success: false, error: 'User not found' };
  }

  const isValid = await verifyPassword(currentPassword, user.passwordHash);
  if (!isValid) {
    return { success: false, error: 'Current password is incorrect' };
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
    select: { id: true },
  });

  // Revoke all existing sessions — if the user changed their password because
  // they suspect compromise, the attacker's sessions must be invalidated.
  await revokeAllRefreshTokens(userId);

  return { success: true };
}

class SameUsernameError extends Error {
  constructor() {
    super('SAME_USERNAME');
    this.name = 'SameUsernameError';
  }
}

export async function changeUsername(
  userId: string,
  newUsername: string,
  meta?: { ipAddress?: string; userAgent?: string },
): Promise<{
  success: boolean;
  error?: 'USERNAME_TAKEN' | 'SAME_USERNAME' | 'USER_NOT_FOUND';
  user?: { id: string; username: string; plan: string; planExpiresAt: Date | null; emailVerified: boolean };
}> {
  const existingUsers = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE LOWER(username) = LOWER(${newUsername}) LIMIT 1
  `;
  const existingUser = existingUsers[0] ?? null;

  if (existingUser && existingUser.id !== userId) {
    return { success: false, error: 'USERNAME_TAKEN' };
  }

  try {
    // Read oldUsername from DB inside the transaction — not from the JWT payload,
    // which may be stale if the user renamed on another device.
    const updatedUser = await prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { username: true },
      });
      if (!current) {
        // Thrown with P2025-like shape so the outer catch maps to USER_NOT_FOUND
        throw { code: 'P2025' };
      }

      const oldUsername = current.username;
      if (newUsername.toLowerCase() === oldUsername.toLowerCase()) {
        throw new SameUsernameError();
      }

      const user = await tx.user.update({
        where: { id: userId },
        data: { username: newUsername },
        select: {
          id: true,
          username: true,
          plan: true,
          planExpiresAt: true,
          emailVerified: true,
        },
      });

      await tx.usernameChangeAudit.create({
        data: {
          userId,
          oldUsername,
          newUsername,
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        },
      });

      return user;
    });

    return { success: true, user: updatedUser };
  } catch (e: unknown) {
    if (e instanceof SameUsernameError) {
      return { success: false, error: 'SAME_USERNAME' };
    }
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return { success: false, error: 'USERNAME_TAKEN' };
    }
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2025') {
      return { success: false, error: 'USER_NOT_FOUND' };
    }
    throw e;
  }
}

/**
 * Check if a username is already taken
 */
export async function usernameExists(username: string): Promise<boolean> {
  // Case-insensitive lookup matches the unique-index constraint on LOWER(username).
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "User" WHERE LOWER(username) = LOWER(${username}) LIMIT 1
  `;
  return rows.length > 0;
}

export async function emailExists(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  return !!user;
}

/**
 * Create a new user account with password
 */
// Usernames that conflict with API route prefixes, UI tabs, or common reserved words.
// Checked case-insensitively during signup.
const RESERVED_USERNAMES = new Set([
  // System / admin
  '_system', 'system',
  // API route prefixes
  'auth', 'health', 'market', 'portfolio', 'dividends', 'settings', 'insights',
  'goals', 'intelligence', 'leaderboard', 'users', 'social', 'transactions',
  'alerts', 'price-alerts', 'analyst', 'milestones', 'fundamentals', 'nala',
  'watchlists', 'stock-follows', 'creator', 'referral', 'notifications', 'plaid',
  'billing', 'waitlist',
  // UI tab names / routes
  'profile', 'discover', 'feed', 'watch', 'pricing', 'macro',
  // Common reserved words
  'admin', 'api', 'www', 'app', 'help', 'support', 'about', 'login', 'signup',
  'register', 'invite', 'account', 'dashboard', 'home', 'index', 'privacy', 'terms',
  'tos', 'null', 'undefined', 'favicon', 'robots', 'sitemap',
  // Authority / trust impersonation
  'moderator', 'mod', 'staff', 'official', 'verified', 'customer_service',
  'helpdesk', 'operator', 'ceo', 'cto', 'cfo', 'founder', 'developer',
  'engineer', 'security', 'root', 'superuser', 'sysadmin',
  // Brokerage / fintech brand impersonation
  'robinhood', 'fidelity', 'schwab', 'vanguard', 'etrade', 'webull',
  'coinbase', 'binance', 'ameritrade', 'merrill', 'sofi', 'wealthfront',
  'betterment', 'charles_schwab', 'td_ameritrade', 'interactive_brokers',
  // Profanity / slurs
  'fuck', 'shit', 'ass', 'asshole', 'bitch', 'bastard', 'damn', 'dick',
  'pussy', 'cock', 'cunt', 'fag', 'faggot', 'nigger', 'nigga', 'retard',
  'slut', 'whore', 'rape', 'nazi', 'hitler', 'kkk',
]);

// Prefixes that indicate impersonation or abuse
const BLOCKED_PREFIXES = ['admin_', 'mod_', 'staff_', 'official_'];

// Brand substring — always blocked regardless of position
const BLOCKED_SUBSTRINGS_ALWAYS = ['nala'];

// Profanity patterns — matched as whole segments between word boundaries (underscores/digits/start/end)
// This avoids false positives like "scunthorpe" or "shitake"
const BLOCKED_PROFANITY_PATTERN = /(?:^|_)(fuck|shit|nigger|nigga|faggot|cunt|fag)(?:_|$)/;

export function isReservedUsername(username: string): boolean {
  const lower = username.toLowerCase();
  if (RESERVED_USERNAMES.has(lower)) return true;
  if (BLOCKED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (BLOCKED_SUBSTRINGS_ALWAYS.some((s) => lower.includes(s))) return true;
  if (BLOCKED_PROFANITY_PATTERN.test(lower)) return true;
  return false;
}

export async function signup(
  username: string,
  email: string,
  displayName: string,
  password: string,
  consentMeta?: { ipAddress?: string; userAgent?: string },
  referralCode?: string
): Promise<LoginResponse | { error: string } | null> {
  const normalizedEmail = normalizeEmail(email);

  // Block reserved usernames that would conflict with routes
  if (isReservedUsername(username)) {
    return { error: 'Username is reserved' };
  }

  // Gate signup behind waitlist approval (when enabled)
  // Admin emails bypass the waitlist gate entirely
  if (config.waitlistEnabled && !config.waitlistAdminEmails.includes(normalizedEmail)) {
    const waitlistEntry = await prisma.waitlist.findUnique({ where: { email: normalizedEmail } });
    if (!waitlistEntry || waitlistEntry.status !== 'approved') {
      return { error: 'WAITLIST_NOT_APPROVED' };
    }
  }

  // Check if username already exists
  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });

  if (existing) {
    return null;
  }

  const existingEmail = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existingEmail) {
    return null;
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username,
          email: normalizedEmail,
          emailVerified: false,
          displayName,
          passwordHash,
          profilePublic: true,
          leaderboardEligible: true,
          trackingStartAt: new Date(),
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          emailVerified: true,
          plan: true,
          planExpiresAt: true,
        },
      });

      await tx.userSettings.create({
        data: {
          userId: newUser.id,
          cashBalance: 0,
          marginDebt: 0,
          dripEnabled: false,
        },
      });

      await tx.consentRecord.create({
        data: {
          userId: newUser.id,
          policyVersion: CURRENT_POLICY_VERSION,
          ipAddress: consentMeta?.ipAddress,
          userAgent: consentMeta?.userAgent,
        },
      });

      return newUser;
    });
  } catch (e: unknown) {
    // Handle race condition: username or email taken between check and create
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'P2002') {
      return null;
    }
    throw e;
  }

  // Mark waitlist entry as converted (non-blocking)
  if (config.waitlistEnabled) {
    prisma.waitlist.update({
      where: { email: normalizedEmail },
      data: { convertedAt: new Date() },
    }).catch(() => { /* non-critical */ });
  }

  // Create default alert preferences (non-blocking — includes congress_trade)
  import('./alert.service').then(m => m.ensureDefaultAlerts(user.id)).catch(() => {});

  // Process referral (non-blocking — don't fail signup if referral fails)
  if (referralCode) {
    try {
      const { processReferral } = await import('./referral.service');
      await processReferral(user.id, referralCode);
    } catch {
      // Referral processing failed — don't block signup
    }
  }

  const token = generateAccessToken({
    userId: user.id,
    username: user.username,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
    emailVerified: user.emailVerified ?? false,
  });
  const refreshToken = await generateRefreshToken(user.id);
  await issueEmailVerificationCode(user.id, normalizedEmail);

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified,
      plan: user.plan,
      planExpiresAt: user.planExpiresAt,
    },
  };
}

export async function verifyEmailCode(
  email: string,
  code: string
): Promise<{ success: boolean; remainingAttempts: number; error?: 'INVALID_OR_EXPIRED' | 'TOO_MANY_ATTEMPTS'; user?: { id: string; username: string; plan: string; planExpiresAt: Date | null; emailVerified: boolean } }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, username: true, emailVerified: true, plan: true, planExpiresAt: true },
  });
  if (!user) {
    return { success: false, remainingAttempts: EMAIL_VERIFY_MAX_ATTEMPTS, error: 'INVALID_OR_EXPIRED' };
  }
  if (user.emailVerified) {
    // Already verified — return success but NO user object (prevents token reissuance)
    return { success: true, remainingAttempts: EMAIL_VERIFY_MAX_ATTEMPTS };
  }

  const otp = await prisma.emailOtpCode.findFirst({
    where: { userId: user.id, purpose: OTP_PURPOSE.EMAIL_VERIFICATION, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    return { success: false, remainingAttempts: 0, error: 'INVALID_OR_EXPIRED' };
  }

  const failedAttempts = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'email_verification_failed',
      sentAt: { gte: otp.createdAt },
    },
  });
  const remainingBefore = EMAIL_VERIFY_MAX_ATTEMPTS - failedAttempts;
  if (remainingBefore <= 0) {
    return { success: false, remainingAttempts: 0, error: 'TOO_MANY_ATTEMPTS' };
  }

  const match = await bcrypt.compare(code, otp.codeHash);
  if (!match) {
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'email_verification_failed',
        status: 'failed',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
    return {
      success: false,
      remainingAttempts: Math.max(0, remainingBefore - 1),
      error: 'INVALID_OR_EXPIRED',
    };
  }

  const usedAt = new Date();
  await prisma.$transaction([
    prisma.emailOtpCode.updateMany({
      where: { userId: user.id, purpose: OTP_PURPOSE.EMAIL_VERIFICATION, usedAt: null },
      data: { usedAt },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
      select: { id: true },
    }),
  ]);

  // Update referral status to 'verified'
  try {
    const { markReferralVerified } = await import('./referral.service');
    await markReferralVerified(user.id);
  } catch {
    // Non-critical
  }

  return { success: true, remainingAttempts: EMAIL_VERIFY_MAX_ATTEMPTS, user: { ...user, emailVerified: true } };
}

export async function resendVerificationEmail(
  email: string
): Promise<{ success: boolean; error?: 'ALREADY_VERIFIED' | 'RATE_LIMIT' }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, emailVerified: true },
  });

  // Return success for unknown email to avoid account enumeration.
  if (!user) {
    return { success: true };
  }
  if (user.emailVerified) {
    return { success: false, error: 'ALREADY_VERIFIED' };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const resentCount = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'email_verification_resent',
      sentAt: { gte: oneHourAgo },
    },
  });
  if (resentCount >= EMAIL_RESEND_LIMIT_PER_HOUR) {
    return { success: false, error: 'RATE_LIMIT' };
  }

  await issueEmailVerificationCode(user.id, normalizedEmail);
  await prisma.notificationAuditLog.create({
    data: {
      userId: user.id,
      type: 'email_verification_resent',
      status: 'sent',
      channel: 'email',
      refKey: crypto.randomUUID(),
    },
  });

  return { success: true };
}

export async function requestPasswordReset(email: string): Promise<{ success: true }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true },
  });

  if (!user?.email) {
    return { success: true };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const requestCount = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'password_reset_requested',
      sentAt: { gte: oneHourAgo },
    },
  });

  if (requestCount < PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR) {
    await issuePasswordResetCode(user.id, user.email);
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'password_reset_requested',
        status: 'sent',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
  }

  return { success: true };
}

export async function requestUsernameReminder(email: string): Promise<{ success: true }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, username: true },
  });

  if (!user?.email || !user.username) {
    return { success: true };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const requestCount = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'username_reminder_requested',
      sentAt: { gte: oneHourAgo },
    },
  });

  if (requestCount < PASSWORD_RESET_REQUEST_LIMIT_PER_HOUR) {
    await sendUsernameReminderEmail(user.email, user.username);
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'username_reminder_requested',
        status: 'sent',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
  }

  return { success: true };
}

export async function resetPasswordWithCode(
  email: string,
  code: string,
  newPassword: string
): Promise<{ success: boolean; remainingAttempts: number; error?: 'INVALID_OR_EXPIRED' | 'TOO_MANY_ATTEMPTS' }> {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (!user) {
    return { success: false, remainingAttempts: PASSWORD_RESET_MAX_ATTEMPTS, error: 'INVALID_OR_EXPIRED' };
  }

  const otp = await prisma.emailOtpCode.findFirst({
    where: { userId: user.id, purpose: OTP_PURPOSE.PASSWORD_RESET, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    return { success: false, remainingAttempts: 0, error: 'INVALID_OR_EXPIRED' };
  }

  const failedAttempts = await prisma.notificationAuditLog.count({
    where: {
      userId: user.id,
      type: 'password_reset_failed',
      sentAt: { gte: otp.createdAt },
    },
  });
  const remainingBefore = PASSWORD_RESET_MAX_ATTEMPTS - failedAttempts;
  if (remainingBefore <= 0) {
    return { success: false, remainingAttempts: 0, error: 'TOO_MANY_ATTEMPTS' };
  }

  const match = await bcrypt.compare(code, otp.codeHash);
  if (!match) {
    await prisma.notificationAuditLog.create({
      data: {
        userId: user.id,
        type: 'password_reset_failed',
        status: 'failed',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
    return {
      success: false,
      remainingAttempts: Math.max(0, remainingBefore - 1),
      error: 'INVALID_OR_EXPIRED',
    };
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  await prisma.$transaction([
    prisma.emailOtpCode.updateMany({
      where: { userId: user.id, purpose: OTP_PURPOSE.PASSWORD_RESET, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
      select: { id: true },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
  invalidateRecentRefreshRotations({ userId: user.id });

  return { success: true, remainingAttempts: PASSWORD_RESET_MAX_ATTEMPTS };
}

/**
 * Two-step "change primary email" — step 1: verify current password, send a
 * 6-digit code to the proposed new address. The User row is NOT modified until
 * confirmEmailChange() succeeds. Errors are returned as discriminated codes so
 * the controller can map them to status codes.
 */
export async function requestEmailChange(
  userId: string,
  currentPassword: string,
  newEmail: string
): Promise<
  | { success: true }
  | { success: false; error: 'USER_NOT_FOUND' | 'NO_PASSWORD' | 'INVALID_PASSWORD' | 'SAME_EMAIL' | 'EMAIL_TAKEN' | 'RATE_LIMITED' }
> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) return { success: false, error: 'USER_NOT_FOUND' };
  if (!user.passwordHash) return { success: false, error: 'NO_PASSWORD' };

  const passwordValid = await verifyPassword(currentPassword, user.passwordHash);
  if (!passwordValid) return { success: false, error: 'INVALID_PASSWORD' };

  const normalizedNew = normalizeEmail(newEmail);
  if (user.email && normalizeEmail(user.email) === normalizedNew) {
    return { success: false, error: 'SAME_EMAIL' };
  }

  // Pre-check the global uniqueness constraint. Race-safe: we recheck at confirm time
  // inside the transaction, but blocking obviously-taken addresses up front gives
  // the user a clear error rather than a confusing "code accepted, then 409".
  const taken = await prisma.user.findUnique({
    where: { email: normalizedNew },
    select: { id: true },
  });
  if (taken && taken.id !== user.id) {
    return { success: false, error: 'EMAIL_TAKEN' };
  }

  // Per-user rate limit on requests (mirrors password reset).
  // Admins (WAITLIST_ADMIN_USER_IDS) skip this service-level cap. The IP-level
  // limiter also bypasses for them, so dev accounts can iterate freely.
  const isAdmin = config.waitlistAdminUserIds.includes(user.id);
  if (!isAdmin) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const requestCount = await prisma.notificationAuditLog.count({
      where: {
        userId: user.id,
        type: 'email_change_requested',
        sentAt: { gte: oneHourAgo },
      },
    });
    if (requestCount >= EMAIL_CHANGE_REQUEST_LIMIT_PER_HOUR) {
      return { success: false, error: 'RATE_LIMITED' };
    }
  }

  const code = generateEmailOtpCode();
  const codeHash = await bcrypt.hash(code, config.bcryptOtpSaltRounds);
  const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MS);

  // Invalidate any prior pending changes for this user so only the newest is live.
  await prisma.pendingEmailChange.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.pendingEmailChange.create({
    data: { userId: user.id, newEmail: normalizedNew, codeHash, expiresAt },
  });

  try {
    await sendEmailChangeVerification(normalizedNew, code);
  } catch {
    console.error('Email-change verification send failed');
  }

  await prisma.notificationAuditLog.create({
    data: {
      userId: user.id,
      type: 'email_change_requested',
      status: 'sent',
      channel: 'email',
      refKey: crypto.randomUUID(),
    },
  });

  return { success: true };
}

/** Mask an email address for display in notifications (e.g. j***@example.com). */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 1))}${domain}`;
}

/**
 * Two-step "change primary email" — step 2: verify the 6-digit code and apply
 * the email change atomically. Sets emailVerified=true on success since the
 * code itself proves control of the new address.
 *
 * On success we also (a) revoke all other refresh tokens — the account's
 * recovery channel just changed, so any extant session is no longer trusted —
 * and (b) best-effort notify the OLD address so a stolen-password takeover
 * leaves an audit trail outside the attacker's reach.
 */
export async function confirmEmailChange(
  userId: string,
  code: string
): Promise<{
  success: boolean;
  remainingAttempts: number;
  error?: 'INVALID_OR_EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'EMAIL_TAKEN';
  email?: string;
}> {
  const pending = await prisma.pendingEmailChange.findFirst({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!pending) {
    return { success: false, remainingAttempts: 0, error: 'INVALID_OR_EXPIRED' };
  }

  const failedAttempts = await prisma.notificationAuditLog.count({
    where: {
      userId,
      type: 'email_change_failed',
      sentAt: { gte: pending.createdAt },
    },
  });
  const remainingBefore = EMAIL_CHANGE_MAX_ATTEMPTS - failedAttempts;
  if (remainingBefore <= 0) {
    return { success: false, remainingAttempts: 0, error: 'TOO_MANY_ATTEMPTS' };
  }

  const match = await bcrypt.compare(code, pending.codeHash);
  if (!match) {
    await prisma.notificationAuditLog.create({
      data: {
        userId,
        type: 'email_change_failed',
        status: 'failed',
        channel: 'email',
        refKey: crypto.randomUUID(),
      },
    });
    return {
      success: false,
      remainingAttempts: Math.max(0, remainingBefore - 1),
      error: 'INVALID_OR_EXPIRED',
    };
  }

  // Capture the old email BEFORE the update so we can notify it after.
  const userBefore = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const oldEmail = userBefore?.email ?? null;

  // Atomic apply: the conditional updateMany on `usedAt: null` guards against
  // a concurrent confirm racing the pending row (e.g. double-click + retry).
  // The User.email unique constraint catches the race against another user
  // claiming the same address between request and confirm.
  const now = new Date();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const consumed = await tx.pendingEmailChange.updateMany({
        where: { id: pending.id, usedAt: null },
        data: { usedAt: now },
      });
      if (consumed.count === 0) {
        // Another concurrent confirm already used this code. Treat as already-consumed.
        return 'ALREADY_CONSUMED' as const;
      }
      await tx.user.update({
        where: { id: userId },
        data: { email: pending.newEmail, emailVerified: true },
        select: { id: true },
      });
      // Email change rotates the recovery channel — revoke all sessions so
      // anyone who was riding the old credential has to re-authenticate.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return 'OK' as const;
    });
    if (result === 'ALREADY_CONSUMED') {
      return { success: false, remainingAttempts: 0, error: 'INVALID_OR_EXPIRED' };
    }
  } catch (e: unknown) {
    // Prisma unique-constraint violation code is P2002.
    const errCode = (e as { code?: string })?.code;
    if (errCode === 'P2002') {
      return { success: false, remainingAttempts: remainingBefore, error: 'EMAIL_TAKEN' };
    }
    throw e;
  }

  invalidateRecentRefreshRotations({ userId });

  // Best-effort notice to the OLD address so a stolen-password takeover leaves
  // an audit trail outside the attacker's reach. Must not fail the flow.
  if (oldEmail) {
    sendEmailChangedNotice(oldEmail, maskEmail(pending.newEmail)).catch((err) => {
      console.warn('[EmailChange] Failed to notify old address:', err instanceof Error ? err.message : String(err));
    });
  }

  return { success: true, remainingAttempts: EMAIL_CHANGE_MAX_ATTEMPTS, email: pending.newEmail };
}

