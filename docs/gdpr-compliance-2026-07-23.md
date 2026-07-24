# GDPR/CCPA compliance — backend batch (2026-07-23)

From a full data-rights review of both repos. Account deletion was already ~50
tables complete; the gaps were one deletion orphan, no complete data-export, and
no re-consent signal. All three backend gaps are now closed and shipped. The
user-facing pieces (a "download my data" button, a re-consent modal, local
disclaimers on overlay modals) are UI and go to Jon's visual pass.

## SHIPPED (backend, verified 1238 tests green, tsc clean, blind-reviewed)

1. **GDPR Art.15/20 data export** — `GET /auth/export-data` (`heavyReadLimiter` +
   `requireAuthAllowUnverified`), backed by `src/services/data-export.service.ts`
   `exportUserData()`. Returns a downloadable JSON attachment of the user's own data
   across ~30 tables (profile, settings, consent, portfolios/holdings/lots/trades/
   ledger/transactions/dividends, goals, watchlists, snapshots, alerts, milestones,
   anomalies, social, deep-research, Plaid metadata, creator subs/wallet, analytics,
   API-usage, MFA method types).
   **Secrets excluded BY CONSTRUCTION:** password hash, refresh/session tokens, MFA
   secrets + backup codes, email OTPs, and Plaid access tokens are never queried;
   the secret/identifier-bearing tables that ARE included use an explicit allow-list
   select verified against the schema (`User` minus passwordHash/stripe/provider ids,
   `PlaidItem` minus `accessTokenEnc`, `MfaMethod` minus `secretCiphertext`, and
   `CreatorSubscription` minus `stripeSubscriptionId` — the last caught by blind review:
   its OR-scope can return a creator's subscribers' rows, so the Stripe billing id must
   not ride along). Every query is guarded so a missing model/transient error yields
   `null`, never a 500; the snapshot query is capped (`take: 50000`) so a huge history
   can't force a multi-MB in-memory serialization.
2. **Deletion completeness** — the erase path (`deleteAccountHandler`) now also removes
   `ApiUsageLog` (the sole non-cascading orphan: `userId String?`, no relation) and
   the origin `Waitlist` row (keyed by email), placed in the guaranteed (fail-closed)
   section so a swallowed cleanup error can't leave them behind. Closes the privacy
   policy §6 "permanently removed" contradiction.
3. **Re-consent signal** — `GET /auth/me` now returns `needsReconsent` (true when the
   user has no `ConsentRecord` for `CURRENT_POLICY_VERSION`) + `currentPolicyVersion`.
   Inert today (everyone consented to 1.0); flips to `true` for existing users the
   moment the policy version is bumped, so the UI can gate a re-prompt.

## FLAGGED — for you (UI visual pass, or a decision)

- **[UI] Wire the export into Settings** — a "Download all my data" button calling
  `GET /auth/export-data`, alongside the existing holdings-only CSV.
- **[UI] Re-consent modal** driven by `needsReconsent` — shown when the policy version
  bumps.
- **[UI] Local "Not financial advice" disclaimers** on the overlay surfaces the global
  footer can't reach: DailyReportModal, PerformanceReportModal/ReportModal, and an
  explicit note on LeaderboardPage (optionally IncomeInsights/HeroInsights/InsightsPage/
  NalaScore). Most advice-adjacent surfaces are already covered by the app-shell footer
  + local disclaimers; these are the overlay-modal gaps.
- **[BACKEND, deferred] Harden the deletion `try/catch`** (`auth.controller.ts` extended
  cleanup): narrow/fail-close the broad swallow so a partial failure can't `SetNull`-orphan
  optional financial rows. Left as-is this pass (restructuring the deletion path is
  high-blast-radius); the core auth + the two new GDPR deletes are already in the
  fail-closed section.
- **[POLICY] Privacy-policy text** promises a full-data export (§7) — now true — and
  "permanent removal" (§6) — now true. No standalone privacy/retention doc exists in
  the repo; the policy lives in the UI `PrivacyPolicyModal`. Worth a standalone doc when
  formalizing.

## Verified clean (no action)

Account deletion covers ~50 userId tables (explicit deletes + `onDelete: Cascade`);
consent is recorded on BOTH signup paths (password + OAuth) with policyVersion + ip +
user-agent; a holdings-only client-side CSV export already exists in Settings.
