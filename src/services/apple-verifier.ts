import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { APPLE_ROOT_CERTS } from '../certs/apple-root-certs';
import type { AppleEnvironment } from './apple-reconciliation-queue.service';
import type { DecodedTransaction, DecodedRenewal } from './apple-server-api';

/**
 * Apple JWS trust boundary.
 *
 * Everything downstream of this module treats decoded payloads as verified fact,
 * so this is the single place where "Apple said so" is established. It is
 * deliberately separate from the legacy apple-iap.service.ts verifier, which
 * builds ONE verifier whose environment is derived from NODE_ENV — fine for a
 * single-environment webhook path, wrong for a reconciler that must serve
 * Production and Sandbox side by side and never let one vouch for the other.
 *
 * ── THE ERROR TAXONOMY IS LOAD-BEARING ────────────────────────────────────
 *
 * A verification failure is either a statement about the DATA or about our
 * ability to check it, and the two must not share a retry policy:
 *
 *   permanent  bad signature, wrong bundle, wrong environment, broken chain
 *              → the payload will never become valid. Retrying forever burns
 *                the queue and hides the real problem.
 *
 *   transient  the library could not COMPLETE the check — OCSP unreachable,
 *              certificate-status lookup failing, network trouble
 *              → the payload may well be fine; try again with backoff.
 *
 * Apple's own VerificationStatus already draws this line
 * (RETRYABLE_VERIFICATION_FAILURE vs the rest), so the mapping below follows the
 * library rather than our guesswork.
 *
 * ── SECRECY ───────────────────────────────────────────────────────────────
 *
 * No error raised here carries JWS contents, bearer tokens, private key
 * material, key ids or issuer ids. A verification failure is reported by its
 * CLASS, not by echoing the thing that failed — an error string is the easiest
 * way for signed payloads to end up in a log aggregator.
 */

export class AppleVerificationPermanentError extends Error {
  constructor(readonly reason: string) {
    super(`apple verification failed permanently: ${reason}`);
    this.name = 'AppleVerificationPermanentError';
  }
}

export class AppleVerificationTransientError extends Error {
  constructor(readonly reason: string) {
    super(`apple verification could not complete: ${reason}`);
    this.name = 'AppleVerificationTransientError';
  }
}

/** Names for VerificationStatus codes — never the payload that produced them. */
const STATUS_REASON: Record<number, string> = {
  [VerificationStatus.VERIFICATION_FAILURE]: 'signature verification failure',
  [VerificationStatus.INVALID_APP_IDENTIFIER]: 'app identifier mismatch',
  [VerificationStatus.INVALID_ENVIRONMENT]: 'environment mismatch',
  [VerificationStatus.INVALID_CHAIN_LENGTH]: 'invalid certificate chain length',
  [VerificationStatus.INVALID_CERTIFICATE]: 'invalid certificate',
  [VerificationStatus.FAILURE]: 'verification failure',
  [VerificationStatus.RETRYABLE_VERIFICATION_FAILURE]: 'retryable verification failure',
};

/**
 * Statuses that are statements about the DATA. Enumerated explicitly rather than
 * "everything that is not retryable", so a status Apple adds later — or any
 * value we do not recognise — cannot be silently promoted to permanent.
 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([
  VerificationStatus.VERIFICATION_FAILURE,
  VerificationStatus.INVALID_APP_IDENTIFIER,
  VerificationStatus.INVALID_ENVIRONMENT,
  VerificationStatus.INVALID_CHAIN_LENGTH,
  VerificationStatus.INVALID_CERTIFICATE,
  VerificationStatus.FAILURE,
]);

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  VerificationStatus.RETRYABLE_VERIFICATION_FAILURE,
]);

/**
 * Classify a thrown verification error.
 *
 * UNKNOWN IS TRANSIENT, in both directions:
 *
 *  - an unrecognised VerificationStatus (a value Apple adds, or anything outside
 *    the enum) is transient, because we cannot claim it says the data is bad;
 *  - a non-VerificationException error is transient, because it is an
 *    infrastructure failure as far as we can tell.
 *
 * There is deliberately NO inspection of error message text. Inferring trust
 * policy from English prose is unsound — an OCSP timeout whose message happens
 * to contain "parse" would be promoted to permanent and park a healthy
 * subscription forever. Apple's verifier already converts malformed JWS,
 * validator and certificate problems into VerificationException statuses, so the
 * enum is the whole signal.
 */
export function classifyVerificationError(err: unknown): Error {
  if (err instanceof VerificationException) {
    const status = err.status as number;
    if (PERMANENT_STATUSES.has(status)) {
      return new AppleVerificationPermanentError(STATUS_REASON[status] ?? `status ${status}`);
    }
    if (RETRYABLE_STATUSES.has(status)) {
      return new AppleVerificationTransientError(STATUS_REASON[status] ?? `status ${status}`);
    }
    return new AppleVerificationTransientError(`unrecognised verification status ${status}`);
  }
  return new AppleVerificationTransientError('verifier infrastructure error');
}

export interface AppleVerifierConfig {
  bundleId: string;
  /** Apple's numeric app id. Required by the library for production checks. */
  appAppleId?: number;
  /** Online OCSP revocation checks. Disabled in tests via the factory. */
  enableOnlineChecks?: boolean;
  rootCertificates?: Buffer[];
}

const ENVIRONMENT_MAP: Record<AppleEnvironment, Environment> = {
  Production: Environment.PRODUCTION,
  Sandbox: Environment.SANDBOX,
};

export interface AppleVerifier {
  verifyTransaction(environment: AppleEnvironment, jws: string): Promise<DecodedTransaction>;
  verifyRenewal(environment: AppleEnvironment, jws: string): Promise<DecodedRenewal>;
}

/**
 * Build a verifier that keeps ONE SignedDataVerifier per environment.
 *
 * Separate instances are the point: each is constructed with its own
 * Environment, so a Sandbox payload presented as Production fails inside the
 * library rather than relying on a downstream field comparison. Production and
 * Sandbox therefore cannot share verification assumptions even by accident.
 */
export function createAppleVerifier(
  cfg: AppleVerifierConfig,
  /** Injected so tests can substitute a stub without Apple's PKI or network. */
  verifierFactory: (env: AppleEnvironment) => SignedDataVerifier = (env) =>
    new SignedDataVerifier(
      cfg.rootCertificates ?? APPLE_ROOT_CERTS,
      cfg.enableOnlineChecks ?? true,
      ENVIRONMENT_MAP[env],
      cfg.bundleId,
      cfg.appAppleId,
    ),
): AppleVerifier {
  const cache = new Map<AppleEnvironment, SignedDataVerifier>();
  const verifierFor = (env: AppleEnvironment): SignedDataVerifier => {
    let v = cache.get(env);
    if (!v) { v = verifierFactory(env); cache.set(env, v); }
    return v;
  };

  /**
   * Independent assertions on the DECODED payload.
   *
   * These REQUIRE the fields rather than checking them "if present". Apple's
   * library already refuses a transaction whose bundle or environment is missing
   * or mismatched, so demanding exact equality costs nothing against real
   * payloads — and it is what makes this check genuinely independent of the
   * library rather than a restatement of it. An "if present" check passes
   * vacuously exactly when the payload is most suspicious.
   */
  const assertIdentity = (
    env: AppleEnvironment,
    decoded: Record<string, unknown>,
    opts: { requireBundleId: boolean },
  ): void => {
    if (opts.requireBundleId) {
      const bundleId = decoded.bundleId as string | undefined;
      if (!bundleId || bundleId !== cfg.bundleId) {
        throw new AppleVerificationPermanentError('app identifier mismatch');
      }
    }
    const environment = decoded.environment as string | undefined;
    if (!environment || environment !== env) {
      throw new AppleVerificationPermanentError('environment mismatch');
    }
  };

  return {
    async verifyTransaction(environment, jws) {
      let decoded: Record<string, unknown>;
      try {
        decoded = (await verifierFor(environment).verifyAndDecodeTransaction(jws)) as unknown as Record<string, unknown>;
      } catch (err) {
        throw classifyVerificationError(err);
      }
      assertIdentity(environment, decoded, { requireBundleId: true });
      if (typeof decoded.transactionId !== 'string' || typeof decoded.originalTransactionId !== 'string') {
        throw new AppleVerificationPermanentError('verified transaction missing required identifiers');
      }
      return decoded as unknown as DecodedTransaction;
    },

    async verifyRenewal(environment, jws) {
      let decoded: Record<string, unknown>;
      try {
        decoded = (await verifierFor(environment).verifyAndDecodeRenewalInfo(jws)) as unknown as Record<string, unknown>;
      } catch (err) {
        throw classifyVerificationError(err);
      }
      // Renewal payloads carry environment but not bundleId.
      assertIdentity(environment, decoded, { requireBundleId: false });
      return decoded as unknown as DecodedRenewal;
    },
  };
}
