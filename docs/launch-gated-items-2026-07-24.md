# Launch items gated on Jon — verified status, 2026-07-24

Every row below was checked against the **live Railway environment and current
code**, not against notes. Two items previously tracked as "gated" are already
done, and one may be actively degrading prod.

> **Secrets are never printed in this doc.** Presence was checked by variable
> name only.

| # | Item | Believed | **Verified** |
|---|---|---|---|
| 1 | `CLOUDFLARE_ORIGIN_SECRET` | gated | **SET** — but see ⚠️ below |
| 2 | `SNAPSHOT_RETENTION_ENABLED` | gated | **SET** — done, corroborated by prod data |
| 3 | `SENTRY_DSN` | — | **SET** |
| 4 | R2 offsite backup (`R2_*`) | gated | **STILL MISSING** — all four absent |
| 5 | `setup-sentry-alerts.ts` | gated | **NOT RUN** — needs one-shot local token |
| 6 | GitHub PAT rotation | gated | blocked on the `piques15` flag appeal |
| 7 | **APNS / Apple key rotation** | — | **NEW — recommended, see §7** |

---

## ⚠️ 1. Origin lockdown (H4/S-18) — SET, but verify the edge rule NOW

`CLOUDFLARE_ORIGIN_SECRET` is present in Railway. That means the code path is
**active**, not inert. The behaviour depends entirely on whether Cloudflare is
actually injecting the `X-Origin-Auth` header:

`src/middleware/rateLimiter.ts:32-41`

```ts
if (!secret) return true;                    // inert — legacy behaviour
const provided = request.headers['x-origin-auth'];
if (typeof provided !== 'string' || provided.length === 0) return false;
```

- **Edge rule IS configured** → working as designed. `CF-Connecting-IP` is
  trusted only on proven-Cloudflare requests. This is the intended hardening.
- **Edge rule is NOT configured** → `isViaCloudflare()` returns `false` for all
  web traffic, and `clientIp()` (`:64-70`) falls back to `request.ip`. Per the
  function's own comment at `:44-50`, behind Cloudflare that means *"every
  visitor collapses onto ONE shared IP and the IP-keyed limiters bucket the
  whole site together (a single user then trips the 'global' limit by
  themselves)"*.

`config/index.ts:225` warns: **"Set the Cloudflare rule FIRST, verify the header
arrives, THEN set this."** If the secret went in first, web rate limiting is
degraded right now.

**Verify (Jon — needs the Cloudflare dashboard):**
1. Cloudflare → the `nalaai.com` zone → Rules → Transform Rules → Modify Request
   Header. Confirm a rule adds `X-Origin-Auth` with a value **exactly** equal to
   `CLOUDFLARE_ORIGIN_SECRET` (compared with `timingSafeEqual`, so any
   whitespace or length difference fails).
2. If no such rule exists, either create it, **or** unset
   `CLOUDFLARE_ORIGIN_SECRET` in Railway to restore the inert legacy path until
   you can. Unsetting is the fast, safe rollback.
3. Full procedure: `docs/H4-origin-lockdown.md`.

---

## ✅ 2. Snapshot retention — DONE

`SNAPSHOT_RETENTION_ENABLED` is set. Independently corroborated by the P0 audit:
prod holds **366,589** `PortfolioSnapshot` rows across a 99-day window, down from
the ~6.78M pre-incident. The nightly prune is running. No action.

---

## 4. R2 offsite backup — the only genuine remaining gap

All four required vars are absent, so `offsite-backup.service.ts:346` logs
`[Offsite] R2_* env vars not set — daily off-site ship NOT scheduled.` and the
daily ship never schedules.

**This is the highest-value item you can unblock.** As of the 2026-07-11
incident, a single volume file was the only backup in existence.

Required (`offsite-backup.service.ts:11-17`):

| Var | Where to get it |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare dashboard → R2 → account ID |
| `R2_ACCESS_KEY_ID` | R2 → Manage API Tokens → create token (Object Read & Write) |
| `R2_SECRET_ACCESS_KEY` | shown once at token creation |
| `R2_BUCKET` | bucket name — **must already exist, it is not auto-created** |
| `R2_PREFIX` | optional, defaults to `nala-backups/` |

```bash
railway variables --set R2_ACCOUNT_ID=... --set R2_ACCESS_KEY_ID=... \
  --set R2_SECRET_ACCESS_KEY=... --set R2_BUCKET=...
```

Ships daily at **08:10 UTC** (`:352`). Verify the morning after by listing the
bucket, and confirm the `offsite_backup` Sentry component stays quiet.

---

## 5. Sentry alert rules — one command, needs a disposable token

`SENTRY_DSN` is already set, so events are flowing; what is missing is the
**alert rules that route them to a notification**. Eight rules, covering the
exact precursors to both 2026-07 outages, which currently fire events with no
rule attached (`scripts/setup-sentry-alerts.ts:35-45`).

These are **not** Railway variables — they are one-shot local env for the script:

```bash
SENTRY_AUTH_TOKEN=<token> SENTRY_ORG_SLUG=<org> \
  npx ts-node scripts/setup-sentry-alerts.ts
```

Token from <https://sentry.io/settings/auth-tokens/>, scope `project:write`.
The script is **idempotent** (PATCHes a same-named rule rather than duplicating),
so it is safe to re-run. **Revoke the token afterwards** — the header says so.

Set `SENTRY_PROJECT` too if your project slug is not `nala`.

---

## 6. GitHub PAT rotation — still blocked upstream

Blocked on the `piques15` account-flag appeal. Watch email including spam. Once
cleared: rotate the Bottlenecks routine PAT, then confirm 2FA / sessions / apps.

---

## 7. NEW — rotate the APNS and Apple Sign-In keys

During this audit a command intended to print only variable *names* piped
`railway variables --kv` through `cut -d= -f1`. `APNS_PRIVATE_KEY` and
`APPLE_PRIVATE_KEY` are multi-line PEM blocks, so their body lines were emitted
as if they were names. Fragments of both EC private keys — including the PKCS#8
header and the opening bytes of each private scalar — landed in an agent
transcript.

Not complete keys, but a meaningful portion, in stored logs. Rotate both:

- **APNS auth key** — Apple Developer → Certificates, IDs & Profiles → Keys →
  revoke the old key, create a new one, update `APNS_PRIVATE_KEY` (and
  `APNS_KEY_ID` if it changes).
- **Sign in with Apple key** — same section; update `APPLE_PRIVATE_KEY` /
  `APPLE_KEY_ID`.

Neither rotation is user-visible; both are a regenerate-and-replace.

**Lesson for future audits:** never derive names by splitting `--kv` output.
Query names structurally (`railway variables --json` and read the object keys)
so multi-line values cannot masquerade as keys.

---

## Suggested order

1. **Verify the Cloudflare Transform Rule (§1)** — potentially degrading prod now.
2. **R2 creds (§4)** — the real backup gap.
3. **Rotate the two Apple keys (§7).**
4. **Run the Sentry alert script (§5)** — 2 minutes once you have a token.
5. GitHub PAT (§6) when the appeal clears.
