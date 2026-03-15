# RC Process

Date: 2026-03-10
Owner: Backend

## 1. When to Cut an RC Branch

Cut an RC branch when:
- Planned features for the release are code-complete and merged to `master`.
- Schema migrations required for the release are finalized.
- Blocking incidents from previous release are closed or explicitly deferred.
- Test suite is passing on current `master`.

Branch naming:
- `rc/YYYY-MM-DD` or `rc/vX.Y.Z`

Cut steps:
1. Ensure local `master` is up to date.
2. Create branch from `master`.
3. Tag commit SHA in release tracker.
4. Announce RC start in team channel.

## 2. Freeze Policy

Feature freeze after RC cut:
- No new features.
- No refactors not tied to release risk.
- No dependency upgrades unless security-critical.

Allowed during RC:
- Bug fixes required for launch.
- Regression fixes found in RC testing.
- Operational/config fixes needed for deploy safety.

Merge control:
- Every RC change must reference a tracked issue.
- Each fix should be a focused single-purpose commit.

## 3. Pre-RC Testing Checklist

Run on RC branch before release approval:
1. `npm test`
2. `npx tsc --noEmit`
3. `scripts/regression-test.sh`
4. Smoke test against release candidate environment.
5. Verify webhook endpoints still pass signature/idempotency checks.
6. Verify Prisma schema/migrations are in sync (no drift).
7. Confirm no unresolved critical Sentry alerts introduced by RC.

Release gate:
- RC cannot ship with failing regression script or unresolved P0/P1 defects.

## 4. Rollback Procedure

Trigger rollback if:
- Elevated 5xx rate persists beyond threshold.
- Auth, billing, or portfolio core endpoints fail in production.
- Data corruption risk is detected.

Rollback steps:
1. Identify last known good commit/tag.
2. Redeploy last known good build in Railway.
3. Verify `/health`, `/health/status`, and key smoke routes.
4. Announce rollback complete with timestamp and reason.
5. Open incident report and block further deploys until root cause is understood.

Data considerations:
- If release included migrations, verify rollback compatibility before redeploy.
- For non-reversible migration risk, apply forward-fix rather than binary rollback.

## 5. Hotfix Process

Use hotfix when production issue is urgent and isolated.

Flow:
1. Branch from current production commit (`hotfix/<short-description>`).
2. Implement smallest safe fix.
3. Run:
   - `npx tsc --noEmit`
   - `npm test`
   - targeted smoke checks for affected endpoints
4. Open expedited review.
5. Merge to `master` and deploy.
6. Backfill release notes and incident timeline.

After hotfix:
- Verify metrics/error rate normalize.
- Add regression test coverage for the bug to prevent recurrence.
