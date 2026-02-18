# Email Verification + AI Guard Audit (2026-02-18)

## Summary
- Smoke script extended with optional signup -> verify -> AI unlock flow.
- Route tests added for `POST /auth/verify-email` and `POST /auth/resend-verification`.
- Route-layer email verification middleware added to AI endpoints.
- Perplexity/Nala AI logs redacted to avoid dynamic error payload leakage.
- TypeScript compile and targeted tests pass.

## Evidence
- Smoke flow logic:
  - `scripts/smoke-test.js:5`
  - `scripts/smoke-test.js:61`
  - `scripts/smoke-test.js:96`
  - `scripts/smoke-test.js:140`
  - `scripts/smoke-test.js:224`
- Auth verification routes:
  - `src/routes/auth.routes.ts:47`
  - `src/routes/auth.routes.ts:50`
- Route tests:
  - `src/__tests__/auth.email-verification.routes.test.ts`
  - Result: 6 passing tests
- Email verification middleware:
  - `src/middleware/email-verification.middleware.ts:5`
- AI route chains:
  - `src/routes/market.routes.ts:23`
  - `src/routes/market.routes.ts:24`
  - `src/routes/insights.routes.ts:34`
  - `src/routes/insights.routes.ts:35`
  - `src/routes/insights.routes.ts:36`
- Controller fallback checks:
  - `src/controllers/market.controller.ts:332`
  - `src/controllers/market.controller.ts:381`
  - `src/controllers/insights.controller.ts:138`
  - `src/controllers/insights.controller.ts:165`
  - `src/controllers/insights.controller.ts:248`
- Log hygiene updated:
  - `src/services/perplexity-qa.service.ts`
  - `src/services/perplexity-events.service.ts`
  - `src/services/perplexity-briefing.service.ts`
  - `src/services/perplexity-behavior.service.ts`
  - `src/services/perplexity-daily-report.service.ts`
  - `src/services/nala-research.service.ts`

## Route Policy Matrix
| Route | Method | Middleware Chain | Status |
|---|---|---|---|
| `/market/stock/:ticker/ai-events` | GET | `heavyReadLimiter -> requireAuth -> requireEmailVerifiedForAi -> requirePlan('premium') -> getAIEventsHandler` | PASS |
| `/market/stock/:ticker/ask` | POST | `mutationLimiter -> requireAuth -> requireEmailVerifiedForAi -> requirePlan('premium') -> askStockQuestionHandler` | PASS |
| `/insights/briefing` | GET | `heavyReadLimiter -> requireAuth -> requireEmailVerifiedForAi -> requirePlan('premium') -> getBriefingHandler` | PASS |
| `/insights/briefing/explain` | POST | `mutationLimiter -> requireAuth -> requireEmailVerifiedForAi -> requirePlan('pro') -> explainBriefingHandler` | PASS |
| `/insights/behavior` | GET | `heavyReadLimiter -> requireAuth -> requireEmailVerifiedForAi -> requirePlan('premium') -> getBehaviorHandler` | PASS |

## Validation Results
- `npx.cmd tsc --noEmit`: PASS
- `npm.cmd test -- src/__tests__/auth.email-verification.routes.test.ts src/__tests__/auth.validators.test.ts`: PASS (26 tests)
