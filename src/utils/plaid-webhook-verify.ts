import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { config } from '../config';

// Cache JWKs to avoid fetching on every webhook
const keyCache = new Map<string, { key: crypto.KeyObject; fetchedAt: number }>();
const KEY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Initialize a separate Plaid client for webhook verification
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[config.plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaidClientId,
      'PLAID-SECRET': config.plaidSecret,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

/**
 * Verify a Plaid webhook JWT signature.
 *
 * Plaid signs webhooks with a JWS (ES256) token in the Plaid-Verification header.
 * The JWT contains a `request_body_sha256` claim that must match the SHA-256 of the raw body.
 *
 * Steps:
 * 1. Decode the JWT header to get the key ID (kid)
 * 2. Fetch the corresponding JWK from Plaid's /webhook_verification_key/get endpoint
 * 3. Verify the JWT signature using the public key
 * 4. Verify the request body hash matches
 *
 * @returns true if the webhook is valid, false otherwise
 */
export async function verifyPlaidWebhook(
  verificationHeader: string,
  rawBody: string
): Promise<boolean> {
  try {
    // 1. Decode JWT header (without verification) to get kid
    const decoded = jwt.decode(verificationHeader, { complete: true });
    if (!decoded || !decoded.header || !decoded.header.kid) {
      console.error('[Plaid Webhook] JWT missing kid in header');
      return false;
    }

    const { kid } = decoded.header;

    // 2. Get the public key (from cache or fetch from Plaid)
    const publicKey = await getPublicKey(kid);
    if (!publicKey) {
      console.error('[Plaid Webhook] Failed to fetch public key');
      return false;
    }

    // 3. Verify JWT signature
    const payload = jwt.verify(verificationHeader, publicKey, {
      algorithms: ['ES256'],
    }) as { request_body_sha256: string; iat: number };

    // 4. Verify request body hash
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    if (payload.request_body_sha256 !== bodyHash) {
      console.error('[Plaid Webhook] Body hash mismatch');
      return false;
    }

    // 5. Verify token is not too old (5 minutes)
    const now = Math.floor(Date.now() / 1000);
    if (now - payload.iat > 5 * 60) {
      console.error('[Plaid Webhook] Token expired (outside 5-minute window)');
      return false;
    }

    return true;
  } catch (_err) {
    console.error('[Plaid Webhook] Verification failed');
    return false;
  }
}

/**
 * Fetch a JWK from Plaid and convert to a crypto.KeyObject.
 * Results are cached for 24 hours.
 */
async function getPublicKey(kid: string): Promise<crypto.KeyObject | null> {
  // Check cache
  const cached = keyCache.get(kid);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL) {
    return cached.key;
  }

  try {
    const response = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
    const jwk = response.data.key;

    // Convert JWK to KeyObject
    const keyObject = crypto.createPublicKey({
      key: jwk as unknown as crypto.JsonWebKey,
      format: 'jwk',
    });

    keyCache.set(kid, { key: keyObject, fetchedAt: Date.now() });
    return keyObject;
  } catch (_err) {
    console.error('[Plaid Webhook] Key fetch failed');
    // Evict stale cache entry
    keyCache.delete(kid);
    return null;
  }
}
