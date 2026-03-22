// ── Content Moderation Filter ────────────────────────────────────────
// Checks user-generated text against blocked patterns for hate speech,
// slurs, violent threats, sexual content, and targeted harassment.
// Includes financial-context awareness to avoid false positives on
// common market language ("kill it", "short", "bearish", "crash", etc.).

export interface FilterResult {
  allowed: boolean;
  reason?: string;
  severity?: 'warn' | 'block';
}

// ── Financial false-positive guards ─────────────────────────────────
// If the surrounding context matches one of these patterns we skip the
// block even when a keyword fires.  All checks are case-insensitive.
const FINANCIAL_CONTEXT_PATTERNS: RegExp[] = [
  /kill(ing|ed|s)?\s+(it|the\s+game|earnings|quarter|market)/i,
  /short(ing|ed|s)?\s+(the\s+stock|squeeze|interest|position|sell|term|dated)/i,
  /short\s+on\s+\w/i,
  /going\s+short/i,
  /short\s+\$?[A-Z]{1,5}\b/i,
  /crash(ing|ed|es)?\s+(the\s+market|hard|down|today|yesterday|soon)/i,
  /market\s+crash/i,
  /flash\s+crash/i,
  /dead\s+cat\s+bounce/i,
  /killing\s+it/i,
  /executed|execution/i,
  /nuke(d|s)?\s+(earnings|the\s+market)/i,
  /bomb(ed|s|ing)?\s+(earnings|the\s+quarter|the\s+market)/i,
  /blow(n|s|ing)?\s+up\s+(the\s+market|my\s+account|the\s+portfolio)/i,
  /target\s+price/i,
  /price\s+target/i,
  /take\s+a\s+hit/i,
  /hit\s+(the\s+target|resistance|support|all.?time)/i,
  /tank(ed|ing|s)?\b/i,
  /slaughter(ed)?\s+(the\s+bears|the\s+bulls|earnings)/i,
  /massacre\s+(of\s+shorts|on\s+wall\s+street)/i,
  /get\s+wrecked\s+(shorts|bears|bulls)/i,
];

function hasFinancialContext(text: string): boolean {
  for (const pattern of FINANCIAL_CONTEXT_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ── Blocked pattern categories ──────────────────────────────────────
// Each entry: [regex, category, severity]
// The regexes use word boundaries (\b) to minimise false positives.
// We intentionally keep the list focused on clear-cut violations.

type BlockedEntry = [RegExp, string, 'warn' | 'block'];

const BLOCKED_PATTERNS: BlockedEntry[] = [
  // ── Racial / ethnic slurs ──────────────────────────────────────
  [/\bn[i1l!|]gg[e3a][r$z]?s?\b/i, 'racial_slur', 'block'],
  [/\bn[i1l!|]gga\b/i, 'racial_slur', 'block'],
  [/\bk[i1!]ke[s]?\b/i, 'racial_slur', 'block'],
  [/\bsp[i1!]c[sk]?\b/i, 'racial_slur', 'block'],
  [/\bch[i1!]nk[s]?\b/i, 'racial_slur', 'block'],
  [/\bgook[s]?\b/i, 'racial_slur', 'block'],
  [/\bwetback[s]?\b/i, 'racial_slur', 'block'],
  [/\bcoon[s]?\b(?!\s*(creek|rapids|dog))/i, 'racial_slur', 'block'],
  [/\bbeaner[s]?\b/i, 'racial_slur', 'block'],
  [/\bsand\s*n[i1!]gg/i, 'racial_slur', 'block'],
  [/\btowel\s*head[s]?\b/i, 'racial_slur', 'block'],
  [/\bcamel\s*jockey[s]?\b/i, 'racial_slur', 'block'],
  [/\brag\s*head[s]?\b/i, 'racial_slur', 'block'],

  // ── Hate speech ────────────────────────────────────────────────
  [/\bheil\s*hitler\b/i, 'hate_speech', 'block'],
  [/\bwhite\s*power\b/i, 'hate_speech', 'block'],
  [/\bwhite\s*supremac/i, 'hate_speech', 'block'],
  [/\b(death|die)\s+to\s+(all\s+)?(jews|blacks|whites|muslims|arabs|asians|mexicans|gays|trans|immigrants|women)\b/i, 'hate_speech', 'block'],
  [/\b(gas|burn|lynch|hang)\s+the\s+(jews|blacks|whites|muslims|arabs|asians|mexicans|gays|trans)\b/i, 'hate_speech', 'block'],
  [/\bf[a@]gg?[o0]t[s]?\b/i, 'hate_speech', 'block'],
  [/\btr[a@]nn(y|ie)[s]?\b/i, 'hate_speech', 'block'],
  [/\bsieg\s*heil\b/i, 'hate_speech', 'block'],
  [/\b14\s*88\b/i, 'hate_speech', 'block'],
  [/\brace\s*war\b/i, 'hate_speech', 'block'],
  [/\bethnic\s*cleansing\b/i, 'hate_speech', 'block'],
  [/\bgenocide\s+(them|the\s+\w+)/i, 'hate_speech', 'block'],

  // ── Violent threats ────────────────────────────────────────────
  [/\bi('ll|'?m\s+going\s+to|'?m\s+gonna)\s+(kill|murder|shoot|stab|hurt)\s+(you|him|her|them|that\s+guy|everyone)\b/i, 'violent_threat', 'block'],
  [/\bi\s+(will|want\s+to|wanna|am\s+going\s+to|am\s+gonna)\s+(kill|murder|shoot|stab|hurt)\s+(you|him|her|them|that\s+guy|everyone)\b/i, 'violent_threat', 'block'],
  [/\bkill\s+your\s*self\b/i, 'violent_threat', 'block'],
  [/\bkys\b/i, 'violent_threat', 'block'],
  [/\b(go\s+)?(hang|shoot|stab|cut)\s+yourself\b/i, 'violent_threat', 'block'],
  [/\byou\s+should\s+(die|kill\s+yourself|end\s+your\s+life)\b/i, 'violent_threat', 'block'],
  [/\bi\s+hope\s+you\s+die\b/i, 'violent_threat', 'block'],
  [/\b(gonna|going\s+to)\s+(shoot|bomb|blow)\s+(up\s+)?(the|this|a)\s+(school|building|office|place)/i, 'violent_threat', 'block'],
  [/\bschool\s+shoot/i, 'violent_threat', 'block'],
  [/\bmass\s+shoot/i, 'violent_threat', 'block'],

  // ── Sexual content ─────────────────────────────────────────────
  [/\b(child|kiddie|cp)\s*porn/i, 'sexual_content', 'block'],
  [/\bpedoph/i, 'sexual_content', 'block'],

  // ── Targeted harassment ────────────────────────────────────────
  [/\b(you('re|\s+are)|ur)\s+(a\s+)?(worthless|pathetic|disgusting|retard(ed)?|subhuman)\b/i, 'targeted_harassment', 'block'],
  [/\bno\s*one\s+(loves|cares\s+about)\s+you\b/i, 'targeted_harassment', 'block'],
  [/\bthe\s+world\s+(is|would\s+be)\s+better\s+(off\s+)?without\s+you\b/i, 'targeted_harassment', 'block'],
  [/\bdox(x)?(ed|ing)?\b/i, 'targeted_harassment', 'warn'],
  [/\bswat(t)?(ed|ing)?\b/i, 'targeted_harassment', 'block'],
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Check text against content moderation rules.
 *
 * @returns `{ allowed: true }` for clean text,
 *          `{ allowed: false, reason, severity }` for violations.
 */
export function filterContent(text: string): FilterResult {
  if (!text || text.trim().length === 0) return { allowed: true };

  // Normalise for detection: collapse excessive whitespace / leetspeak is
  // partially handled by the regex alternations above.
  const normalised = text.replace(/\s+/g, ' ');

  for (const [pattern, reason, severity] of BLOCKED_PATTERNS) {
    if (pattern.test(normalised)) {
      // Financial-context guard: only for certain categories and only when
      // the matched keyword plausibly appears in market talk.
      if (
        (reason === 'violent_threat' || reason === 'targeted_harassment') &&
        hasFinancialContext(normalised)
      ) {
        continue;
      }
      return { allowed: false, reason, severity };
    }
  }

  return { allowed: true };
}

/**
 * Strip HTML tags and dangerous unicode control characters.
 *
 * This is the canonical implementation — import it in any service that
 * needs input sanitisation.
 */
export function sanitizeContent(input: string): string {
  return input
    // Strip null bytes and dangerous unicode bidi/zero-width characters
    .replace(/[\x00\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Strip HTML tags (React escapes on render, but strip to prevent storage of markup)
    .replace(/<[^>]*>/g, '');
}

/**
 * Validate that a citation URL is a safe, public HTTP(S) URL.
 * Rejects non-HTTP protocols, credentials in the URL, and private/local addresses.
 */
export function validateCitationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('172.')) return false;
    return true;
  } catch { return false; }
}

// ── Content Policy (for UI display) ─────────────────────────────────

export const CONTENT_POLICY = {
  summary:
    'Nala is a community for investors. We have zero tolerance for hate speech, racism, threats of violence, or targeted harassment.',
  rules: [
    'No racial slurs, ethnic slurs, or hate speech of any kind',
    'No threats of violence or encouragement of self-harm',
    'No sexually explicit content',
    'No targeted harassment or bullying of other users',
    'No spam or misleading financial claims presented as fact',
  ],
  enforcement: [
    'First offense: Content removed + warning',
    'Second offense: 7-day account suspension',
    'Third offense: Permanent ban',
  ],
  dueProcess: {
    summary: 'Every user has the right to understand why action was taken and to appeal.',
    steps: [
      'When content is blocked, the user sees the specific rule violated',
      'When a strike is issued, the user is notified with the reason and evidence',
      'Users can submit one appeal per strike within 30 days',
      'Appeals are reviewed by the Nala team within 48 hours',
      'If an appeal is successful, the strike is removed and any suspension is reconsidered',
      'Users may request a full review of their moderation history at any time',
    ],
    appealWindow: 30, // days
    reviewSLA: 48, // hours
  },
};
