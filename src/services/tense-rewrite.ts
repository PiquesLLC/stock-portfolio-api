import type { MarketState } from '../utils/market-state';
import type { DailyReportResponse } from './perplexity-daily-report.service';

// Plural-noun heads that should take "are" instead of "is" when they immediately precede a
// rewritten session verb. Anything not in this set defaults to "is" (correct for tickers,
// "the index", proper nouns, and most singular subjects).
const PLURAL_CUES = new Set([
  'markets', 'stocks', 'shares', 'yields', 'rates', 'indices', 'indexes',
  'futures', 'bonds', 'prices', 'equities', 'gainers', 'losers', 'sectors',
  'holdings', 'names', 'players', 'banks', 'retailers', 'companies', 'automakers',
  'commodities', 'returns', 'gains', 'losses', 'flows', 'they',
]);

// Conjunctions, connector words, and bare quantifiers that get captured as the apparent
// "subject" by the preceding-word regex but aren't the real subject. Skip the rewrite when
// these are captured — produces "X and climbed" left as-is (acceptable) rather than the
// ungrammatical "X and is climbing".
const SKIP_SUBJECTS = new Set([
  'and', 'or', 'but', 'yet', 'so', 'nor', 'for',
  'as', 'while', 'when', 'then', 'also', 'plus',
  'where', 'whereas', 'though', 'although', 'because', 'since',
  // Quantifier/compound markers — real subject is in the prior clause.
  'both', 'each', 'neither', 'either', 'all',
  // First/second person pronouns — verbs need "am"/"are" not "is"/"are", and these
  // basically never appear with session verbs in finance prose.
  'i', 'we', 'you',
]);

function aux(subject: string): 'is' | 'are' | null {
  // Skip if the captured "subject" ends in punctuation or a dash — it's almost always an
  // appositive tail or lead-in clause ("April, advanced...", "Friday: rose...",
  // "Markets — advanced..."), not the real grammatical subject.
  if (/[,:;.!?\-–—]$/.test(subject)) return null;
  const clean = subject.replace(/[^a-z]/gi, '').toLowerCase();
  // If clean is empty AND the original had no digits, the captured token was pure
  // punctuation — bail out. Pure-numeric subjects ("the S&P 500 advanced") still fall
  // through to default singular ("is"), since "500" is part of an index name.
  if (!clean && !/\d/.test(subject)) return null;
  if (SKIP_SUBJECTS.has(clean)) return null;
  return PLURAL_CUES.has(clean) ? 'are' : 'is';
}

// Past-simple → present-progressive mapping for unambiguous session verbs.
const VERB_MAP: Record<string, string> = {
  advanced: 'advancing',
  surged: 'surging',
  rose: 'rising',
  fell: 'falling',
  dropped: 'dropping',
  climbed: 'climbing',
  slid: 'sliding',
  settled: 'settling',
  gained: 'gaining',
  lost: 'losing',
  posted: 'posting',
  delivered: 'delivering',
  saw: 'seeing',
  drove: 'driving',
  ended: 'ending',
  finished: 'finishing',
  lagged: 'lagging',
  jumped: 'jumping',
  tumbled: 'tumbling',
  rallied: 'rallying',
  plunged: 'plunging',
  sank: 'sinking',
  edged: 'edging',
  slipped: 'slipping',
  retreated: 'retreating',
  navigated: 'navigating',
  outperformed: 'outperforming',
  underperformed: 'underperforming',
  dipped: 'dipping',
  ticked: 'ticking',
  pushed: 'pushing',
};
// Note on omitted verbs:
// - `traded`: too many non-session uses ("stock traded at 20x earnings yesterday",
//   "shares traded hands") would be wrongly rewritten to present without a positive-context
//   guard for "higher/lower/up/down/sideways/at $X". Skip until that scoping is added.
// - `offset`: past-simple is the same string as present-simple, but more importantly the
//   user's reported phrase ("Gains in TSM offset declines") has a plural head noun the
//   bare-regex loop cannot reach — it would attribute "TSM" as the subject and emit
//   ungrammatical "Gains in TSM is offsetting".

// Multi-word phrase rewrites. Run BEFORE single-word rules so longer matches win.
const PHRASE_RULES: { match: RegExp; ing: string }[] = [
  { match: /(\S+)\s+held\s+firm\b/gi,    ing: 'holding firm' },
  { match: /(\S+)\s+closed\s+out\b/gi,   ing: 'closing out' },
  { match: /(\S+)\s+kicked\s+off\b/gi,   ing: 'kicking off' },
  { match: /(\S+)\s+wrapped\s+up\b/gi,   ing: 'wrapping up' },
  { match: /(\S+)\s+held\s+steady\b/gi,  ing: 'holding steady' },
];

// Single-word verbs whose past-simple form is genuinely ambiguous when followed by a
// long-period object ("ended the year", "navigated last quarter"). The completion is a fact
// about a past period and should NOT be rewritten — the year/quarter/month/week is over,
// even if the trading day is open. The lookahead allows an optional determiner before the
// period word: "the", "last", "this", "next", "each".
const PERIOD_NOOP_LOOKAHEAD = '(?!\\s+(?:(?:the|last|this|next|each)\\s+)?(?:year|quarter|month|week))';
const VERBS_WITH_PERIOD_NOOP = new Set(['ended', 'finished', 'navigated', 'outperformed', 'underperformed']);

// Bloomberg pattern "Shares of TICKER verb" — head noun is "Shares" (plural). Without this
// rule the generic loop captures the ticker as singular and emits "Shares of AMZN is up".
// Derived from VERB_MAP so the two never drift when verbs are added.

export function rewriteToPresentTense(text: string): string {
  if (!text) return text;
  let out = text;

  // Pass 1 — "Shares of TICKER verb" (head noun is "Shares", plural).
  for (const [verb, ing] of Object.entries(VERB_MAP)) {
    const re = new RegExp(`\\b(Shares)\\s+of\\s+(\\S+)\\s+${verb}\\b`, 'gi');
    out = out.replace(re, (_, sharesWord: string, ticker: string) => `${sharesWord} of ${ticker} are ${ing}`);
  }

  // Pass 2 — multi-word phrase rules.
  for (const rule of PHRASE_RULES) {
    out = out.replace(rule.match, (match, subj: string) => {
      const a = aux(subj);
      return a === null ? match : `${subj} ${a} ${rule.ing}`;
    });
  }

  // Pass 3 — single-word verb rules. Period-noop verbs get a negative lookahead so
  // "ended the year" / "finished the quarter" stay past tense.
  for (const [past, ing] of Object.entries(VERB_MAP)) {
    const tail = VERBS_WITH_PERIOD_NOOP.has(past) ? PERIOD_NOOP_LOOKAHEAD : '';
    const re = new RegExp(`(\\S+)\\s+${past}\\b${tail}`, 'gi');
    out = out.replace(re, (match, subj: string) => {
      const a = aux(subj);
      return a === null ? match : `${subj} ${a} ${ing}`;
    });
  }

  return out;
}

export function applyTenseRewriteIfLive(
  report: DailyReportResponse,
  marketState: MarketState,
): DailyReportResponse {
  if (marketState !== 'intraday' && marketState !== 'pre_open') return report;

  return {
    ...report,
    greeting: rewriteToPresentTense(report.greeting),
    marketOverview: rewriteToPresentTense(report.marketOverview),
    portfolioSummary: rewriteToPresentTense(report.portfolioSummary),
    positionMoves: report.positionMoves?.map(m => ({
      ...m,
      reason: rewriteToPresentTense(m.reason),
    })),
    topStories: report.topStories.map(s => ({
      ...s,
      headline: rewriteToPresentTense(s.headline),
      body: rewriteToPresentTense(s.body),
    })),
    questionsOfTheDay: report.questionsOfTheDay?.map(q => ({
      ...q,
      answer: rewriteToPresentTense(q.answer),
    })),
  };
}
