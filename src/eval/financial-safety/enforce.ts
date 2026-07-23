/**
 * Inline AI-safety enforcement.
 *
 * Thin wrapper around the deterministic `validateAiOutput` validator meant to
 * sit in the live AI response path as a last-line backstop: if a generation
 * contains a violation at/above the gate (default: any blocker — guarantee,
 * buy/sell imperative, leverage or all-in coaching), the raw text is replaced
 * with a safe fallback and the violation is logged. Prompt rules are necessary
 * but unenforced; this makes the product fail closed, not open.
 *
 * Pure + synchronous — safe to call on every response with negligible cost.
 */

import { validateAiOutput, type SafetySeverity, type SafetyVerdict } from './validators/ai-output.validator';

/** Last-resort safe text if a caller passes an empty fallback. */
const DEFAULT_SAFE_FALLBACK =
  'This response was withheld by the safety filter. This is educational information only, not financial advice.';

export interface EnforceOptions {
  /** Text served in place of the generation when a violation is found. */
  fallback: string;
  /** Minimum severity that triggers a block. Default: 'blocker'. */
  gate?: SafetySeverity;
  /** Feature label, used in the default log line. */
  feature?: string;
  /** Override the default console.warn logging. */
  onViolation?: (info: { feature?: string; verdict: SafetyVerdict }) => void;
}

export interface EnforceResult {
  /** The text safe to serve — either the original or the fallback. */
  text: string;
  /** True when the original was replaced. */
  blocked: boolean;
  verdict: SafetyVerdict;
}

/**
 * Enforce safety on a single block of AI text. Returns the servable text.
 */
export function enforceAiText(text: string, opts: EnforceOptions): EnforceResult {
  const gate: SafetySeverity = opts.gate ?? 'blocker';
  const verdict = validateAiOutput(text, { minSeverity: gate });
  if (verdict.ok) {
    return { text, blocked: false, verdict };
  }
  if (opts.onViolation) {
    opts.onViolation({ feature: opts.feature, verdict });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[ai-safety] blocked ${opts.feature ?? 'output'}: ` +
        verdict.violations.map((v) => `${v.category}("${v.match}")`).join(', '),
    );
  }
  // Never serve an empty fallback — that would blank the surface on a block.
  const safeFallback = opts.fallback && opts.fallback.trim() ? opts.fallback : DEFAULT_SAFE_FALLBACK;
  return { text: safeFallback, blocked: true, verdict };
}
