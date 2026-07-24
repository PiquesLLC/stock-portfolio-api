# Auth / session security review — 2026-07-23

A four-part adversarial review of the entire auth surface (tokens/sessions/IDOR,
OAuth, MFA/password-recovery, rate-limit/CSRF/transport). **Headline: the core is
solid.** No verified-account takeover, no MFA bypass, no signup-token→session
escalation, no IDOR/tenant-isolation break. The JWT skeleton-key class fixed
earlier today holds. Findings below; two shipped, the rest catalogued with the
delta and what's needed to close them.

## FIXED + shipped this pass (verified, 1233 tests green, blind-reviewed)

1. **[HIGH] Refresh-token exfil via the forgeable `x-nala-native` header.**
   `/auth/refresh` echoed the rotated refresh token into the JSON body whenever
   `isCapacitorRequest()` was true — and that helper trusts the client-settable
   `x-nala-native:1` header. A web XSS payload could set the header, ride the
   browser's httpOnly refresh cookie (`credentials:'include'`), and read the
   freshly-rotated refresh token out of the JSON → persistent account takeover,
   defeating the whole point of httpOnly. **Fix** (`auth.controller.ts` refreshHandler):
   gate the body-echo on a browser-**unforgeable** signal — a genuine Capacitor-scheme
   `Origin` (which a browser cannot set) OR a refresh token supplied in the body
   (cookieless native). Web/XSS has neither, so no token is echoed. Two regression
   tests added; existing native refresh tests still pass.
   **Native-safety VERIFIED against the client** (`stock-portfolio-ui/src/api.ts`
   `tryRefreshToken` :445-481 and `hydrateNativeAuthTokens` :899): the native app reads
   its stored refresh token and SENDS it in the request body, then reads the rotated
   token from the RESPONSE body — on BOTH iOS (`capacitor://localhost` Origin) and
   Android (`https://localhost`, deliberately excluded from NATIVE_ORIGINS). So the
   `bodyToken` branch always fires for native regardless of Origin or cookies; the one
   theoretically-fragile "header-only + cookie-only + reads-body" config does not exist
   in this client. Shipped with confidence.
2. **[MEDIUM] Prod forced `sameSite:'none'` on web cookies**, making a single
   hand-rolled Origin-check middleware the *entire* browser-CSRF defense. Since the
   web app is served from the SAME origin as the API in prod, **`sameSite:'lax'`** is
   sufficient and strictly safer (browser-enforced CSRF backstop). Native keeps
   `'none'` (and authenticates via Bearer anyway). Applied in the three sameSite-computing
   sites (`getCookieOptions` ×2 + `clearAllAuthCookies`); every cookie-SETTING site
   (login/signup/verify-email/changeUsername/refresh/oauth/mfa) inherits it. Verified
   `lax` does NOT break OAuth (token/popup-based, same-origin POST — no cross-site cookie
   step) and set/clear options match (no orphaned cookie on logout).
3. **[LOW] Deleted dead `generateToken()`** — an exported 7-day-JWT mint with zero
   production callers (a footgun if ever wired into a route, bypassing the 15-min
   access-token/rotation model).

## FLAGGED — not shipped (needs a decision, a device test, or your dashboard)

- **[HIGH · GATED ON YOU] S-18 / H4 origin lockdown.** With `CLOUDFLARE_ORIGIN_SECRET`
  unset (it is, in prod), a direct-to-origin attacker forging `CF-Connecting-IP`
  resets EVERY per-IP limiter (login, signup, oauth, mfa, reset, global). Account-bound
  counters (password lockout, MFA-failure lockout, OTP maxAttempts) hold the line, but
  signup abuse, credential-stuffing spread, enumeration, and OTP-email-bombing become
  unthrottled. **Fix is already coded and inert**: create the Cloudflare Transform Rule
  injecting `X-Origin-Auth`, verify it reaches origin, THEN set the secret in Railway
  (rule-first — see `docs/H4-origin-lockdown.md`). This is the single highest-value
  auth hardening and it's a ~10-minute dashboard task.
- **[HIGH-adjacent · NEEDS NATIVE BUILD] Native-detection hardening.** The root cause
  of #1 above — `isCapacitorRequest`'s `x-nala-native` header fallback — also gates the
  login-body token echo and the CSRF-skip (`app.ts:241`). The refresh path is now
  closed on an unforgeable signal, and the sameSite fix neutralizes the CSRF-skip for
  web, but the header fallback should ultimately be removed/replaced with the
  Capacitor-Origin check everywhere. That change must be verified on a real iOS/Android
  build first (some WebView configs rely on the header fallback), so I did not ship it
  blind.
- **[MEDIUM] Login-lockout DoS.** 10 failed passwords hard-locks the account 30 min,
  and the check runs *before* the password check, so an attacker who knows an
  (enumerable) username locks the real owner out — painful during market hours.
  **Fix:** per-(IP,account) backoff or an emailed unlock link instead of a blanket
  time-lock. (Amplified by S-18; not a takeover.)
- **[MEDIUM] OAuth account-adoption merges the squatter's data.** When a real owner
  first signs in via Google/Apple to an email that an attacker pre-registered as an
  *unverified* account, adoption cleans auth vectors (password/refresh/MFA/other-provider)
  but leaves holdings, `cashBalance`, `displayName`/avatar, `profilePublic`,
  `leaderboardEligible`, and `stripeConnectId`/creator profile — the owner inherits a
  "dirty" impersonation-primed account. Not takeover (the attacker loses access), but a
  data-integrity/impersonation issue on a public-profile + leaderboard app. **Fix:** on
  adoption, scrub owner-controlled/public fields (or reclaim only the email into a fresh
  account and quarantine the squat's data). Creator-payout linkage is dormant while
  monetization is OFF.
- **[MEDIUM · SUSPECTED, NEEDS NATIVE FLOW CHECK] Apple `nonce` optional.**
  `verifyAppleToken` only binds the nonce when the client sends one, so a replayed
  Apple id_token can strip it. **Fix:** require a server-issued single-use nonce for the
  Apple flow. Verify the native Apple flow actually issues nonces before enforcing.
- **[LOW] 15-min access-token residual.** No per-user `tokensValidFrom`/epoch, so
  password-change / email-change / OAuth-adoption revoke refresh tokens but an
  already-issued access token stays valid up to 15 min. Add a token-epoch claim or
  accept the window.
- **[LOW] Misc:** email-OTP send has no per-user cap (bombing/Resend cost, IP-gated
  only); signup returns distinct "username taken" vs "email in use" (enumeration
  oracle); login timing oracle (bcrypt only on the valid-user path); `/auth/refresh` +
  `/auth/verify-email` use only the loose global limiter; `config.clearCookieOptions`
  (`sameSite:'strict'`) is inconsistent with the computed set-options but is **dead/unused**
  (referenced only at its definition — no live orphan-cookie risk); `generateOtpCode`
  uses `randomInt(100000,999999)` (upper-exclusive, excludes 999999 — negligible bias).

## VERIFIED CLEAN (checked by reading, no action)

- **JWT:** HS256 pinned on both verifiers; `isAccessTokenPayload` rejects any token
  lacking a string `userId` or carrying a `purpose` claim (closes the skeleton-key /
  signup-token replay class on valid AND expired paths); the only non-access `jwt.sign`
  uses the domain-separated `OAUTH_SIGNUP_SECRET`.
- **Refresh tokens:** SHA-256 hashed at rest, atomic single-use rotation, reuse →
  family-wide revocation + telemetry; the rotation cache encrypts at rest (AES-256-GCM).
  All privileged changes revoke server-side, userId-scoped.
- **IDOR / tenant isolation:** no controller derives the ACTING user from body/query/params;
  no `where:{userId:undefined}` collapse; every client-keyed query is admin-gated or
  preceded by an ownership check. The earlier anomaly fix is correct.
- **OAuth:** verified-account link/adopt is impossible without provider-proven email
  control; MFA can never be skipped (challenge before any link/session; pendingLink
  committed only after atomic challenge-consume); Google `aud` + Apple signature/aud/expiry
  enforced; the age-gate signup token can't be replayed/provider-swapped/skipped.
- **MFA:** 512-bit challenge, 5-min TTL, atomic single-use consume after code check;
  TOTP replay closed; email-OTP + backup codes bcrypt-hashed + single-used; account-bound
  lockout is the real brute-force ceiling.
- **Transport:** CORS allowlist-only (no wildcard/reflection); helmet/CSP (no
  unsafe-inline/eval)/HSTS strong; `trust proxy=1` correct; every auth/MFA/OAuth/reset
  route has a dedicated limiter (the only weakness is the forgeable IP *key* = S-18).

## Recommended next actions (priority order)
1. Activate H4/S-18 (you, ~10 min in Cloudflare) — biggest hardening for least effort.
2. Login-lockout DoS fix (per-(IP,account) backoff).
3. OAuth adoption scrub.
4. Native-detection hardening + login-body echo (behind a real native build test).
5. Apple nonce enforcement (after verifying the native flow).
