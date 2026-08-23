// Tiny helpers for safely interpolating user-controlled values into log
// lines.
//
// Threat model: an authenticated caller submits a request body containing a
// field like `creatorUserId: "victim\n[Admin Ledger] FAKE SUCCESS line"`.
// A naive `console.log(...creatorUserId...)` writes that newline verbatim
// into stdout (and therefore into Railway logs / Datadog / on-call
// dashboards), making it look like a second legitimate log entry. An
// operator reviewing logs during cutover could be misled.
//
// `logSafe` strips control characters and caps length. Use it whenever an
// audit/observability log line includes a value that originated from a
// request body, header, or query string — even from authenticated callers,
// since compromised admin credentials are a real threat model.

const CONTROL_CHARS = /[\r\n\x00-\x1f\x7f]/g;
const DEFAULT_MAX_LENGTH = 128;

/**
 * Render a value for inclusion in a log line. Replaces ASCII control chars
 * (including `\n`, `\r`, NUL, DEL) with `?` and truncates to a max length.
 * Anything non-string is coerced via `String()` first.
 *
 * Returns the literal `'unknown'` for `null` / `undefined` so log lines
 * stay readable when an optional field is missing.
 */
export function logSafe(value: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
  if (value === null || value === undefined) return 'unknown';
  return String(value).replace(CONTROL_CHARS, '?').slice(0, maxLength);
}

// M-13 — PII redaction for diagnostic text.
//
// Some log lines legitimately need a whole error (stack included) to be useful:
// a Resend or Plaid failure is undiagnosable without it. The problem is that a
// provider's error payload frequently embeds the very thing we must not persist
// — the recipient's email address — and that text then lands in Railway stdout
// and Sentry, both of which outlive the request and are read by third parties.
//
// `redactPii` keeps the shape of the message (and the domain, which is what you
// actually need for triage: "all the gmail.com sends are failing") while
// removing the identifying local-part. Bearer tokens and long hex/base64 blobs
// that look like credentials are masked outright.
// Quantifiers are BOUNDED, not open-ended. The domain group is inherently
// ambiguous (`.` sits inside the character class AND is required literally
// after it), so an unbounded `+` makes matching quadratic in the length of a
// dotless alphanumeric run following an `@` — and this runs inside Sentry's
// beforeSend on attacker-influenceable text. RFC-realistic bounds (64-char
// local part, 255-char domain) cap the backtracking without losing real
// addresses.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24})/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,512}/gi;

// Secrets are matched by CONTEXT, not by length.
//
// This was `\b[A-Fa-f0-9]{32,}\b` — redact any long hex run — which was wrong in
// both directions. It destroyed legitimate identifiers (a Sentry trace_id is 32
// hex, a git SHA 40, a SHA-256 hash 64) including the very trace id used to
// correlate a Sentry event with a Railway log line, i.e. it degraded debugging
// inside the tool it runs in. And when the upper bound `{32,128}` was added to
// bound backtracking, it became a BYPASS: a 200-char hex blob matches nothing
// at all, because the greedy 128 fails the trailing `\b`, every shorter length
// fails it too, and every interior start position fails the leading `\b`.
//
// Keying on an adjacent `key=` / `token:` / `"secret":` marker catches the
// shapes that actually carry credentials, leaves opaque ids alone, and has no
// upper bound to bypass. Deliberate consequence: a bare secret with no
// surrounding context is no longer masked here — `?key=` in URLs and
// Authorization headers are handled separately (see app.ts and BEARER_RE).
// NOTE: deliberately no leading `\b`. A word boundary would miss every
// camelCase name — there is no boundary before `Secret` or `Key` in
// `stripeSecretKey=<value>`, and this codebase's config object is written in
// exactly that style (config/index.ts: stripeSecretKey, jwtSecret,
// mfaEncryptionKey, vapidPrivateKey…), so an error echoing a config object
// would have leaked. Without it the match simply starts at the `Key=` suffix,
// which redacts the value just the same. The cost is the odd false positive
// (`monkey=…`), which is the harmless direction for log hygiene.
//
// One known false positive worth naming: `_` is a word character, so dropping
// `\b` also makes `idempotency_key: payout-<id>` match. That string is the
// correlator you would hand Stripe support when investigating a payout, so if
// anyone adds a debug log of it, expect it redacted. Latent today — we log
// payoutId, not the key.
const SECRET_ASSIGNMENT_RE =
  // The optional leading quote matters: in JSON the key's own closing quote sits
  // between the name and the colon (`"apiToken":"…"`), so a separator pattern
  // that starts at `\s*[:=]` never matches serialized objects — which is the
  // most likely way a secret reaches a log in the first place.
  /(api[_-]?key|apikey|key|token|secret|password|passwd|pwd|signature|credential|authorization)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi;

// Redaction is a log-hygiene measure, not a parser. Anything beyond this is
// truncated rather than scanned, so a huge attacker-supplied string cannot
// occupy the event loop inside beforeSend.
const REDACT_SCAN_LIMIT = 20_000;

/**
 * Mask email local-parts, bearer credentials and long hex secrets in free text.
 * Safe to apply to an Error stack — it only rewrites the matched spans.
 *
 * The domain is deliberately preserved ("[email]@gmail.com"): it is what makes
 * a provider failure triageable, and it is not by itself identifying.
 */
export function redactPii(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  const raw = String(value);
  const scanned = raw.length > REDACT_SCAN_LIMIT
    ? `${raw.slice(0, REDACT_SCAN_LIMIT)}…[truncated ${raw.length - REDACT_SCAN_LIMIT} chars]`
    : raw;
  return scanned
    .replace(EMAIL_RE, (_match, domain: string) => `[email]@${domain}`)
    .replace(BEARER_RE, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(SECRET_ASSIGNMENT_RE, (_match, name: string, sep: string) => `${name}${sep}[redacted]`);
}
