# H4 — Origin lockdown for rate-limit IP trust

**Status:** code shipped but **inert** until you set `CLOUDFLARE_ORIGIN_SECRET`.
Read the native-app caveat before activating.

## The problem

The Railway origin `stock-portfolio-api-production.up.railway.app` is reachable
directly, bypassing Cloudflare (verified 2026-06-11: `GET /health` → 200,
`Server: railway-hikari`, no `cf-ray`). Our rate limiters key on the
`CF-Connecting-IP` header. Cloudflare sets it for real web traffic, but an
attacker hitting the origin directly can **forge** it — and by rotating it per
request they reset every per-IP limit, enabling unthrottled login / MFA / OTP
brute force and signup abuse.

(Per-account and per-code caps — login lockout 10/account/30 min, OTP 5/code —
still backstop the most sensitive flows, so this is serious-but-not-catastrophic.
The unbacked exposures are signup abuse and cross-account credential stuffing.
The share-card limiter keys on `req.ip`, not this header, so it was never part of
this attack.)

## ⚠️ Native-app caveat (read first)

The Capacitor **native** app talks to the Railway origin **directly**, not through
Cloudflare — `stock-portfolio-ui/src/config.ts` hardcodes the `*.up.railway.app`
host for native and deliberately refuses the web origin. So:

- Native requests carry **no** `CF-Connecting-IP` and **cannot** carry the secret
  `X-Origin-Auth` (embedding a shared secret in a shipped app would leak it).
- Therefore native traffic is always keyed by `request.ip` (below). That is fine —
  it stays per-client — **as long as Railway's edge writes XFF authoritatively**
  (see verification step). The forged-header reset is still closed for native,
  because we ignore `CF-Connecting-IP` unless `X-Origin-Auth` proves Cloudflare.
- **Do NOT remove the generated `*.up.railway.app` domain** (a tempting "lock to
  Cloudflare" move) — it would break every native build. If you ever want native
  behind Cloudflare too, first give it a CF-proxied API host (e.g. `api.nalaai.com`
  via `VITE_NATIVE_API_URL`) and ship a native build pointed at it.

## The fix

### Part B — Application (this repo, already coded, gated off)

`src/middleware/rateLimiter.ts`:
- `isViaCloudflare(req)` — true only when `X-Origin-Auth` equals
  `CLOUDFLARE_ORIGIN_SECRET` (constant-time). Unset secret → returns true (legacy).
- `clientIp(req)` — trusts `CF-Connecting-IP` only when `isViaCloudflare`; else
  falls back to `request.ip` (the client IP Railway's edge writes into XFF under
  `trust proxy: 1`). It never falls back to a client-settable header, so a forged
  `CF-Connecting-IP` on a direct hit is ignored. With the secret unset this is
  **identical** to the prior behavior, so deploying is inert.

This alone closes the forged-`CF-Connecting-IP` reset once the secret is active:
a direct attacker without `X-Origin-Auth` is keyed by `request.ip` (their real IP
per Railway), which they can't rotate via a header.

### Part A — Infrastructure hardening (optional, defense-in-depth)

Not required to close the bug, and **gated on the native caveat above**:
- Cloudflare **Authenticated Origin Pulls** (mTLS) on the `nalaai.com` custom
  domain so the web origin only accepts Cloudflare — without touching the
  generated domain native depends on.
- Or migrate native to a CF-proxied host, *then* remove the generated domain.

## Pre-activation verification (do this before setting the secret)

1. **Confirm Railway writes XFF authoritatively.** From an outside host:
   `curl -H 'X-Forwarded-For: 1.2.3.4' https://stock-portfolio-api-production.up.railway.app/health`
   and confirm via logs/an echo that the app's `request.ip` is **your real IP**,
   not `1.2.3.4`. If `request.ip` can be spoofed, fix `trust proxy` before relying
   on the fallback (otherwise a direct attacker can rotate XFF instead).

## Rollout order (do NOT reverse — wrong order self-DoSes web traffic)

1. **Cloudflare → Rules → Transform Rules → Modify Request Header.** Add a rule
   that, on all requests, **removes** any client `X-Origin-Auth` then **sets
   static** `X-Origin-Auth = <a long random secret>`. Deploy it.
2. **Verify the header reaches the origin** for web requests (logs / temporary
   echo). Every legit web request must carry it before step 3.
3. **Only then** set `CLOUDFLARE_ORIGIN_SECRET=<same secret>` in Railway
   (triggers a redeploy). The limiter now ignores forged `CF-Connecting-IP` on
   the web path; native keeps keying on `request.ip`.

> ⚠️ Set `CLOUDFLARE_ORIGIN_SECRET` **before** the Transform Rule is live and
> legitimate WEB traffic loses its `CF-Connecting-IP` trust → web users fall back
> to `request.ip`, which behind the CF→Railway double hop collapses to one proxy
> IP → site-wide throttle. Rule first, env var second. Rollback = unset the env
> var (instant return to legacy behavior).

## Verification after rollout

- Web via `nalaai.com` stays per-client limited (log in from two IPs → independent
  counters).
- A direct origin hit with a forged `CF-Connecting-IP` no longer resets limits
  (it keys on `request.ip`).
- Native app login/usage is unaffected (still keyed by `request.ip`).
