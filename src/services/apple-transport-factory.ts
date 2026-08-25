import { AppleServerApiTransport, type AppleTransport } from './apple-server-api';
import { createAppleVerifier, type AppleVerifier, type AppleVerifierConfig } from './apple-verifier';
import { createAppleAuthTokenProvider, type AppleAuthConfig, type AppleAuthTokenProvider } from './apple-auth-token';

/**
 * Wires the real trust chain into AppleServerApiTransport.
 *
 * NOTHING CALLS THIS AUTOMATICALLY. There is no worker loop, no route, no boot
 * hook — constructing the production transport is a deliberate act, and
 * APPLE_IAP_ENABLED remains false. The factory exists so that when a worker
 * runtime does land, it assembles a transport whose verifier and token provider
 * are already reviewed, rather than inventing the wiring at that point.
 */

export interface AppleTransportConfig {
  auth: AppleAuthConfig;
  verifier: AppleVerifierConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProductionAppleTransport {
  transport: AppleTransport;
  tokenProvider: AppleAuthTokenProvider;
  verifier: AppleVerifier;
}

export function createProductionAppleTransport(cfg: AppleTransportConfig): ProductionAppleTransport {
  const tokenProvider = createAppleAuthTokenProvider(cfg.auth);
  const verifier = createAppleVerifier(cfg.verifier);

  /**
   * The environment travels from the request into BOTH the token provider and
   * the verifier. That is what keeps Production and Sandbox from sharing
   * verification assumptions: the transport's own environment argument selects
   * the verifier instance, so a payload cannot be checked against the wrong
   * environment's rules even if a response claims otherwise.
   *
   * The closures below are recreated per call with the environment bound,
   * because AppleServerApiTransport's verifier hooks take only the JWS.
   */
  const transport: AppleTransport = {
    async getAllSubscriptionStatuses(args) {
      const bound = new AppleServerApiTransport({
        getAuthToken: (environment) => tokenProvider.getToken(environment),
        verifyTransaction: (jws) => verifier.verifyTransaction(args.environment, jws),
        verifyRenewal: (jws) => verifier.verifyRenewal(args.environment, jws),
        fetchImpl: cfg.fetchImpl,
        timeoutMs: cfg.timeoutMs,
      });
      return bound.getAllSubscriptionStatuses(args);
    },
  };

  return { transport, tokenProvider, verifier };
}

/**
 * Reads configuration from the environment. Kept separate from the factory so
 * tests never touch process.env, and so a caller can see exactly which variables
 * are required before anything is constructed.
 *
 * ── WHY THESE NAMES ARE APPLE_IAP_-PREFIXED ───────────────────────────────
 *
 * The App Store Server API key is generated separately in App Store Connect
 * (Users and Access → Integrations → In-App Purchase) and Apple states it cannot
 * be shared with other Apple services. The generic names are already taken in
 * this repo, and NOT harmlessly:
 *
 *   APPLE_KEY_ID / APPLE_TEAM_ID / APPLE_PRIVATE_KEY are documented in
 *   .env.example under "OAuth sign-in", AND config/index.ts uses them as APNs
 *   fallbacks (apnsKeyId, apnsTeamId, apnsPrivateKey).
 *
 * So provisioning the IAP key into APPLE_KEY_ID would make push notifications
 * sign with the wrong key, while leaving the sign-in/APNs key there would make
 * App Store Server API authentication fail. Dedicated names remove the choice.
 *
 * APPLE_IAP_ISSUER_ID is the App Store Connect Issuer ID (a UUID) — NOT
 * APPLE_TEAM_ID, which belongs to Sign in with Apple and is a different value.
 * APPLE_BUNDLE_ID and APPLE_APP_APPLE_ID are genuinely shared and keep their
 * names.
 */
export function appleTransportConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppleTransportConfig {
  return {
    auth: {
      issuerId: env.APPLE_IAP_ISSUER_ID ?? '',
      keyId: env.APPLE_IAP_KEY_ID ?? '',
      privateKey: (env.APPLE_IAP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      bundleId: env.APPLE_BUNDLE_ID ?? '',
    },
    verifier: {
      bundleId: env.APPLE_BUNDLE_ID ?? '',
      appAppleId: env.APPLE_APP_APPLE_ID ? Number(env.APPLE_APP_APPLE_ID) : undefined,
      enableOnlineChecks: true,
    },
  };
}

/** Which required settings are missing. Names only — never values. */
export function missingAppleTransportConfig(cfg: AppleTransportConfig): string[] {
  const missing: string[] = [];
  if (!cfg.auth.issuerId) missing.push('APPLE_IAP_ISSUER_ID');
  if (!cfg.auth.keyId) missing.push('APPLE_IAP_KEY_ID');
  if (!cfg.auth.privateKey) missing.push('APPLE_IAP_PRIVATE_KEY');
  if (!cfg.auth.bundleId) missing.push('APPLE_BUNDLE_ID');
  if (!cfg.verifier.appAppleId) missing.push('APPLE_APP_APPLE_ID');
  return missing;
}
