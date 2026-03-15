# Release Notes Template

Release Date: YYYY-MM-DD  
Version: vX.Y.Z  
Commit: <git-sha>

## Summary
- Short description of what this release delivers.

## Backend Changes
- [ ] API endpoint changes
- [ ] Service/business-logic updates
- [ ] Billing/auth changes
- [ ] Job runner/worker changes

## Database / Prisma
- [ ] Migration(s) included:
  - `<migration-folder-name>`
- [ ] Backward compatibility notes
- [ ] Rollback considerations

## Config / Environment
- [ ] New env vars:
  - `VAR_NAME` - purpose
- [ ] Updated env vars:
  - `VAR_NAME` - change
- [ ] Removed env vars:
  - `VAR_NAME` - reason

## Risks and Mitigations
- Risk:
- Mitigation:
- Monitoring signal:

## Validation Performed
- [ ] `npm test`
- [ ] `npx tsc --noEmit`
- [ ] `scripts/regression-test.sh`
- [ ] Production smoke test

## Post-Deploy Checks
- [ ] `/health` and `/health/status` healthy
- [ ] Error rates normal
- [ ] Job runner/dead-letter metrics normal
- [ ] Webhook metrics normal

## Rollback Plan
- Last known good version:
- Rollback command/action:
- Data migration caveats:

## Follow-ups
- [ ] Item 1
- [ ] Item 2
- [ ] Item 3
