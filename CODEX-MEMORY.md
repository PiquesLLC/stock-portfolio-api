# Codex Memory (Do Not Use For Claude)

Purpose: persistent next-session notes for Codex only.
Scope: stock-portfolio-api backend work.

## Tomorrow Morning Priorities

1. Add route-level tests for `/market/search` (controller + middleware behavior), not just utility-level tests.
2. Clean low-risk drift/comment debt in `prisma/schema.prisma` (stale alert-type comments) so audits/docs match code reality.
3. Finish log-hygiene pass in `src/utils/finnhub-queue.ts` (standardize message-only error logging).
4. Run fresh production smoke + env parity check and save an updated audit artifact snapshot for beta readiness.
5. Run Plaid live-readiness drill in staging:
   - Enable `PLAID_ENABLED` with real secrets
   - Validate webhook path + holdings sync end-to-end
   - Document exact go-live steps

## Guardrails

- Keep changes isolated from UI work and Claude in-flight tasks.
- Prefer focused commits (one concern per commit).
- Do not return raw `error` objects in logs or API responses.
