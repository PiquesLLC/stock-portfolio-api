/**
 * Deterministic AI-output safety validator.
 *
 * Scans generated text (Ask Nala, Deep Research, Stock Q&A, daily brief, tax
 * harvest, behaviour coach, etc.) for financial-safety violations that a
 * prompt instruction alone cannot guarantee. This is the "deterministic
 * validator around AI output" the audit calls for: it does NOT trust the model
 * to regulate itself.
 *
 * Design goals:
 *  - Pure + synchronous: no network, no API keys, no DB. Runs in CI and can be
 *    wired inline into the AI response path as a last-line backstop.
 *  - Precision-biased: patterns target imperatives and promises, not neutral
 *    education. "Historically, dividend stocks have..." is fine; "you should
 *    buy X, it's guaranteed to hit $200" is not.
 *  - Explainable: every hit reports the category, severity, and matched span so
 *    a human (or a test) can see exactly why it fired.
 *
 * It is intentionally conservative about false positives on educational phrasing
 * because the product is education-first — but any BLOCKER-severity category is
 * meant to hard-fail a response before it reaches a user.
 */

export type SafetySeverity = 'blocker' | 'high' | 'medium';

export type SafetyCategory =
  | 'guarantee'
  | 'price_target'
  | 'trade_imperative'
  | 'leverage_encouragement'
  | 'concentration_encouragement'
  | 'fomo_pressure'
  | 'unhedged_prediction'
  | 'personalized_advice';

export interface SafetyViolation {
  category: SafetyCategory;
  severity: SafetySeverity;
  /** The exact substring that matched, for debugging and test assertions. */
  match: string;
  /** Character offset of the match within the scanned text. */
  index: number;
  message: string;
}

export interface SafetyVerdict {
  ok: boolean;
  /** Highest severity found, or null when clean. */
  worstSeverity: SafetySeverity | null;
  violations: SafetyViolation[];
}

interface Rule {
  category: SafetyCategory;
  severity: SafetySeverity;
  pattern: RegExp;
  message: string;
  /**
   * Optional guard: given the match and full text, return false to suppress a
   * match that is actually safe in context (e.g. an explicit hedge nearby).
   */
  suppressIf?: (match: RegExpMatchArray, text: string) => boolean;
}

// Hedge cues that, when present in the immediate vicinity of a forward-looking
// statement, indicate the model IS communicating uncertainty. Used to suppress
// unhedged_prediction hits only (never blocker categories).
// Deliberately excludes over-common words ("if", "risk") that let a real
// prediction hide behind an unrelated clause; the cues must signal genuine
// uncertainty about the claim itself.
const HEDGE_CUES = /\b(may|might|could|historically|tend(?:s|ed)? to|analysts?|estimate|projected|potential(?:ly)?|whether|no guarantee|not a guarantee|past performance|uncertain)\b/i;

// Same-clause-ish window: a hedge only counts when it sits close to the claim,
// not anywhere in the paragraph.
function nearbyHasHedge(match: RegExpMatchArray, text: string, radius = 45): boolean {
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + match[0].length + radius);
  return HEDGE_CUES.test(text.slice(start, end));
}

/**
 * True when the matched token is negated by a nearby preceding word — "no
 * guarantee", "don't put all in", "never use margin", "you shouldn't buy now".
 * Allows up to two intervening words (a negator + verb: "don't put all…") so
 * that education which NAMES a risky act in order to warn against it does not
 * hard-fail. This is what separates "go all-in" (unsafe) from "don't go all-in"
 * (safe education).
 */
function precededByNegator(match: RegExpMatchArray, text: string): boolean {
  const idx = match.index ?? 0;
  const before = text.slice(Math.max(0, idx - 28), idx);
  return /\b(?:no|not|never|without|cannot|can'?t|isn'?t|aren'?t|doesn'?t|don'?t|shouldn'?t|wouldn'?t|couldn'?t|won'?t|do not|does not|avoid)\s+(?:\w+\s+){0,2}(?:a\s+|any\s+|your\s+)?$/i.test(before);
}

/**
 * True when a directional verb is immediately followed by the opposite
 * direction ("will rise or fall"), i.e. it is describing possibility in BOTH
 * directions rather than predicting one.
 */
function bidirectionalFollows(match: RegExpMatchArray, text: string): boolean {
  const idx = (match.index ?? 0) + match[0].length;
  const after = text.slice(idx, idx + 20);
  return /^\s+or\s+(?:fall|drop|decline|sink|lose|go down|fall)/i.test(after);
}

/**
 * Rule table. Order does not matter — every rule is evaluated against the whole
 * text and all hits are reported.
 */
const RULES: Rule[] = [
  // ── BLOCKERS ───────────────────────────────────────────────────────────
  {
    category: 'guarantee',
    severity: 'blocker',
    // "risk-free" excludes the finance terms "risk-free rate/asset/bond/
    // treasury/rate of return" via negative lookahead — those are standard
    // macro vocabulary a market brief legitimately cites, not a guarantee claim.
    pattern: /\b(guarantee[ds]?|guaranteed returns?|risk[-\s]?free(?!\s+(?:rate|asset|bond|treasur))|can'?t lose|cannot lose|no downside|sure thing|certain to (?:rise|gain|profit|go up)|100%\s*(?:safe|certain|guaranteed))\b/gi,
    message: 'Return/outcome guarantee language is never permitted.',
    suppressIf: (m, text) => precededByNegator(m, text),
  },
  {
    category: 'trade_imperative',
    severity: 'blocker',
    // Direct instruction to transact. Requires an imperative frame so that
    // "some investors buy on dips" (descriptive) does not trip it. Note:
    // "buy rating" / "buy this kind of stock" are factual/analyst language, not
    // imperatives, so they are deliberately NOT matched.
    pattern: /\b(?:you should (?:buy|sell|dump|short)|buy (?:now|today|immediately)|sell (?:now|today|immediately|everything)|load up on|back up the truck|dump (?:your|this|it))\b/gi,
    message: 'Direct buy/sell instruction — the product must not tell a user to transact.',
    suppressIf: (m, text) => precededByNegator(m, text),
  },
  {
    category: 'leverage_encouragement',
    severity: 'blocker',
    pattern: /\b(use (?:margin|leverage)|borrow(?:ing)? (?:money )?to (?:invest|buy|trade)|take out a loan to (?:invest|buy)|trade on margin|leverage up|max(?:imize)? your leverage|use (?:your )?credit card to (?:invest|buy))\b/gi,
    message: 'Encouraging leverage/borrowed money to invest can cause catastrophic, uncapped loss.',
    suppressIf: (m, text) => precededByNegator(m, text),
  },
  {
    category: 'concentration_encouragement',
    severity: 'blocker',
    pattern: /\b(go all[-\s]?in|put (?:it )?all (?:in|into)|all your (?:money|savings|cash) (?:in|into)|your entire (?:portfolio|savings|net worth) (?:in|into)|bet everything|(?:put|invest) your (?:life )?savings (?:in|into))\b/gi,
    message: 'Encouraging single-asset concentration / all-in allocation is unsuitable for any user.',
    suppressIf: (m, text) => precededByNegator(m, text),
  },

  // ── HIGH ───────────────────────────────────────────────────────────────
  {
    category: 'price_target',
    severity: 'high',
    // A specific future price the *model itself* asserts. We flag a numeric
    // target attached to a directional/temporal verb. Analyst-attributed
    // targets with a hedge nearby are downgraded via suppressIf.
    pattern: /\b(?:will (?:reach|hit|climb to|rise to|be worth|go to)|price target(?: of)?|target price(?: of)?|headed to|going to (?:reach|hit))\s*\$?\d[\d,]*(?:\.\d+)?/gi,
    message: 'Model-asserted price target presented as fact. Targets must be analyst-attributed and hedged.',
    suppressIf: (m, text) => nearbyHasHedge(m, text),
  },
  {
    category: 'personalized_advice',
    severity: 'high',
    // First/second-person prescriptive framing about the individual's own money.
    pattern: /\b(?:you should (?:invest|allocate|put|move|shift)|I (?:recommend|advise|suggest) you|my advice (?:is|to you)|the best (?:stock|investment) for you (?:is|would be)|you need to (?:buy|sell|invest))\b/gi,
    message: 'Personalized directive advice beyond the platform\'s stated educational scope.',
  },
  {
    category: 'fomo_pressure',
    severity: 'high',
    pattern: /\b(don'?t miss out|before it'?s too late|act (?:fast|now|quickly)|last chance|won'?t last long|get in (?:now|early) before|limited time|missing out|fear of missing)\b/gi,
    message: 'Urgency/FOMO pressure encourages impulsive, un-considered trading.',
  },

  // ── MEDIUM ─────────────────────────────────────────────────────────────
  {
    category: 'unhedged_prediction',
    severity: 'medium',
    // Confident directional forecast with no nearby hedge. Suppressed when a
    // hedge cue sits within the surrounding window.
    pattern: /\b(?:will (?:definitely |certainly |surely )?(?:rise|climb|surge|soar|rally|go up|increase|double|triple)|is going to (?:rise|climb|surge|soar|rally|moon|explode)|guaranteed to (?:grow|rise))\b/gi,
    message: 'Unhedged directional prediction stated as fact.',
    suppressIf: (m, text) => nearbyHasHedge(m, text) || bidirectionalFollows(m, text),
  },
];

/**
 * Scan a block of AI-generated text and return a structured verdict.
 *
 * @param text        the model output as it would be shown to the user
 * @param opts.minSeverity  only report violations at/above this severity
 */
export function validateAiOutput(
  text: string,
  opts: { minSeverity?: SafetySeverity } = {},
): SafetyVerdict {
  const violations: SafetyViolation[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: true, worstSeverity: null, violations };
  }

  for (const rule of RULES) {
    // Reset lastIndex on the shared regex per call.
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.suppressIf && rule.suppressIf(match, text)) continue;
      violations.push({
        category: rule.category,
        severity: rule.severity,
        match: match[0],
        index: match.index ?? -1,
        message: rule.message,
      });
    }
  }

  const filtered = opts.minSeverity
    ? violations.filter((v) => severityRank(v.severity) >= severityRank(opts.minSeverity!))
    : violations;

  const worstSeverity = filtered.reduce<SafetySeverity | null>((worst, v) => {
    if (worst === null || severityRank(v.severity) > severityRank(worst)) return v.severity;
    return worst;
  }, null);

  return {
    ok: filtered.length === 0,
    worstSeverity,
    violations: filtered.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.index - b.index),
  };
}

export function severityRank(s: SafetySeverity): number {
  switch (s) {
    case 'blocker':
      return 3;
    case 'high':
      return 2;
    case 'medium':
      return 1;
  }
}

/**
 * Convenience predicate for inline use in the AI response path: returns true
 * when the text is safe enough to serve. A BLOCKER always fails; callers may
 * choose a stricter gate.
 */
export function isServableAiOutput(
  text: string,
  gate: SafetySeverity = 'blocker',
): boolean {
  const verdict = validateAiOutput(text, { minSeverity: gate });
  return verdict.ok;
}
