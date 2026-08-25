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
 * APPLE_ISSUER_ID is the App Store Connect Issuer ID (a UUID) — deliberately NOT
 * APPLE_TEAM_ID, which belongs to Sign in with Apple and is a different value.
 */
export function appleTransportConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppleTransportConfig {
  return {
    auth: {
      issuerId: env.APPLE_ISSUER_ID ?? '',
      keyId: env.APPLE_KEY_ID ?? '',
      privateKey: (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
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
  if (!cfg.auth.issuerId) missing.push('APPLE_ISSUER_ID');
  if (!cfg.auth.keyId) missing.push('APPLE_KEY_ID');
  if (!cfg.auth.privateKey) missing.push('APPLE_PRIVATE_KEY');
  if (!cfg.auth.bundleId) missing.push('APPLE_BUNDLE_ID');
  if (!cfg.verifier.appAppleId) missing.push('APPLE_APP_APPLE_ID');
  return missing;
}
