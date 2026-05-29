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
