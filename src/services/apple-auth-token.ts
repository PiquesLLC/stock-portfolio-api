import * as jose from 'jose';
import type { AppleEnvironment } from './apple-reconciliation-queue.service';

/**
 * App Store Server API bearer tokens (ES256).
 *
 * Apple authenticates the Server API with a short-lived JWT signed by the
 * private key from App Store Connect. The claims are fixed by Apple:
 *
 *   header   alg ES256, kid = the key id, typ JWT
 *   payload  iss = ISSUER ID (App Store Connect, a UUID — NOT the Team ID,
 *                 which is what Sign in with Apple uses)
 *            iat, exp (Apple caps the lifetime at 60 minutes)
 *            aud = "appstoreconnect-v1"
 *            bid = the app's bundle id
 *
 * ── SECRECY ───────────────────────────────────────────────────────────────
 * The private key, key id, issuer id and the minted token never appear in an
 * error message or a log line from this module. Failures are reported by what
 * went wrong structurally ("private key could not be parsed"), never by echoing
 * the material. `describe()` exists so operators can sanity-check configuration
 * without printing any of it.
 */

export class AppleAuthTokenError extends Error {
  constructor(reason: string) {
    super(`apple auth token unavailable: ${reason}`);
    this.name = 'AppleAuthTokenError';
  }
}

export const APPLE_AUDIENCE = 'appstoreconnect-v1';
/** Apple's hard maximum. Anything longer is rejected by the Server API. */
export const APPLE_MAX_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_TTL_SECONDS = 20 * 60;
/** Re-mint this long before expiry so an in-flight request cannot age out. */
const REFRESH_SKEW_SECONDS = 60;

export interface AppleAuthConfig {
  /** App Store Connect Issuer ID (UUID). Not the Team ID. */
  issuerId: string;
  keyId: string;
  /** PEM-encoded ES256 private key (.p8 contents). */
  privateKey: string;
  bundleId: string;
  ttlSeconds?: number;
}

export interface AppleAuthTokenProvider {
  getToken(environment: AppleEnvironment): Promise<string>;
  /** Non-secret configuration summary, safe to log. */
  describe(): { issuerIdPresent: boolean; keyIdPresent: boolean; privateKeyPresent: boolean; bundleId: string; ttlSeconds: number };
}

interface CachedToken { token: string; expiresAtMs: number }

export function createAppleAuthTokenProvider(
  cfg: AppleAuthConfig,
  now: () => number = () => Date.now(),
): AppleAuthTokenProvider {
  const ttlSeconds = Math.min(cfg.ttlSeconds ?? DEFAULT_TTL_SECONDS, APPLE_MAX_TOKEN_TTL_SECONDS);
  if (ttlSeconds <= 0) throw new AppleAuthTokenError('token ttl must be positive');

  /**
   * Cached PER ENVIRONMENT even though the claims are identical today. Keying
   * on environment costs nothing and means a future environment-specific claim
   * cannot silently reuse the other environment's token.
   */
  const cache = new Map<AppleEnvironment, CachedToken>();

  async function mint(): Promise<string> {
    if (!cfg.issuerId) throw new AppleAuthTokenError('issuer id is not configured');
    if (!cfg.keyId) throw new AppleAuthTokenError('key id is not configured');
    if (!cfg.privateKey) throw new AppleAuthTokenError('private key is not configured');
    if (!cfg.bundleId) throw new AppleAuthTokenError('bundle id is not configured');

    // Derived from the import function rather than naming a jose type: the
    // exported key type differs across jose majors, and this cannot drift.
    let key: Awaited<ReturnType<typeof jose.importPKCS8>>;
    try {
      key = await jose.importPKCS8(cfg.privateKey, 'ES256');
    } catch {
      // Deliberately does not include the parse error, which can echo key bytes.
      throw new AppleAuthTokenError('private key could not be parsed as PKCS8 ES256');
    }

    const issuedAt = Math.floor(now() / 1000);
    try {
      return await new jose.SignJWT({ bid: cfg.bundleId })
        .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' })
        .setIssuer(cfg.issuerId)
        .setAudience(APPLE_AUDIENCE)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttlSeconds)
        .sign(key);
    } catch {
      throw new AppleAuthTokenError('token could not be signed');
    }
  }

  return {
    async getToken(environment) {
      const cached = cache.get(environment);
      if (cached && cached.expiresAtMs - REFRESH_SKEW_SECONDS * 1000 > now()) return cached.token;
      const token = await mint();
      cache.set(environment, { token, expiresAtMs: now() + ttlSeconds * 1000 });
      return token;
    },
    describe: () => ({
      issuerIdPresent: Boolean(cfg.issuerId),
      keyIdPresent: Boolean(cfg.keyId),
      privateKeyPresent: Boolean(cfg.privateKey),
      bundleId: cfg.bundleId,
      ttlSeconds,
    }),
  };
}
