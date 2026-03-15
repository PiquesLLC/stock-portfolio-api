# Prisma Upgrade Plan (5.x -> latest stable)

Date: 2026-03-04
Repo: `stock-portfolio-api` (branch: `main`)
Scope: Read-only investigation + upgrade plan. No code changes performed.

## 1) Current state

### Versions in repo
- `package.json` declares:
  - `prisma`: `^5.22.0`
  - `@prisma/client`: `^5.7.0`
- Installed/resolved versions in `node_modules` (via `npm ls`):
  - `prisma@5.22.0`
  - `@prisma/client@5.22.0`

Observation:
- Declared ranges are not aligned (`@prisma/client` range is older than `prisma` range), even though lockfile currently resolves both to `5.22.0`.
- As a baseline hygiene step, these should be pinned/aligned explicitly during upgrade.

### Schema / generator / datasource
From `prisma/schema.prisma`:
- Generator: `provider = "prisma-client-js"`
- Datasource: `provider = "sqlite"`, `url = env("DATABASE_URL")`
- No `previewFeatures` present.
- No Prisma-specific custom client output configured.

### Prisma ecosystem packages in use
- No `@prisma/extension-accelerate`
- No `withAccelerate()` usage
- No `prisma://` URL usage found in repo
- No `@prisma/adapter-*` package usage currently

### Code usage patterns (high level)
- Extensive use of `findUnique`, `findFirst`, `updateMany`, `upsert`, relation queries.
- Transaction usage present (`prisma.$transaction(async tx => ...)` and array form).
- Very limited raw SQL usage in this repo (most queries are Prisma Client API).

---

## 2) Breaking changes review (current -> latest stable)

### Target version context
- Latest stable major in Prisma docs is `v7`.
- Upgrading from current `v5.22.x` to latest stable therefore crosses **two major versions** (`v6` and `v7`).

### Official upgrade docs reviewed
- Upgrade to Prisma ORM 6: https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-6
- Upgrade to Prisma ORM 7: https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7

### Relevant breaking changes (v6)
(From official v6 upgrade guide)
- `PrismaClientKnownRequestError` behavior changed around Error inheritance semantics.
- `jsonProtocol` removed.
- TypeScript generator split / changes.
- Node engine minimum bumped (v6 requires newer Node than old v5 baselines; this repo already targets Node >=20).

Impact on this repo:
- Low to medium risk. This codebase catches Prisma errors mostly by `instanceof Prisma.PrismaClientKnownRequestError` and code checks (`P2002`), which should be revalidated by tests after upgrade.

### Relevant breaking changes (v7)
(From official v7 upgrade guide)
- **`prisma-client-js` generator removed**.
  - Must migrate to `prisma-client` generator.
  - Must define explicit `output` path for generated client.
- **Driver adapters required for all databases**.
  - For SQLite, an adapter package must be added and client initialization updated.
- New generated client import/runtime shape is different from current v5 setup.
- Prisma commands no longer load `.env` from schema directory (if relying on this behavior).

Impact on this repo:
- **High impact** for direct v5 -> v7 jump, because this repo currently relies on:
  - `prisma-client-js`
  - `import { PrismaClient } from '@prisma/client'` across many files
  - no adapter setup

### Focus areas requested
- SQLite provider: materially affected in v7 (adapter requirement).
- `$transaction`: API remains, but runtime should be revalidated after major jump.
- `findUnique` / `findFirst` / relation queries: expected to continue, but type-level behavior and error shapes may differ across majors.
- Raw SQL: minimal usage; still should be regression-tested.
- Migration behavior: see section 4.
- `prisma://` / Accelerate: not used in this repo today; no immediate migration blocker from this specific item.

---

## 3) Schema compatibility assessment

Schema characteristics found:
- Heavy use of:
  - `@@index`, `@unique`, composite unique constraints
  - `onDelete: Cascade` and `onDelete: Restrict`
  - optional relations (`userId String?`, relation fields optional)
- No composite types / Mongo-specific constructs.
- No preview feature flags in schema.

Potential compatibility concerns:
- No obvious schema syntax that is deprecated in v6/v7 for SQLite.
- Main break is generator/runtime model in v7, not schema model shape.
- Existing nullable relation patterns are valid but should be tested for type changes and query assumptions after client regeneration.

Field/attribute rename/removal check:
- No obviously removed schema attributes detected in current schema.
- However, client-side generated types and error classes are where most migration work is expected.

---

## 4) Migration safety

Migration inventory (directory count):
- 13 migration folders under `prisma/migrations/`.

General assessment:
- Existing SQL migrations should remain applicable with newer Prisma versions, provided migration engine runs successfully in target env.
- `prisma migrate deploy` command usage pattern remains standard in this repo (`start` script uses it).

Behavior changes to account for:
- In v7, environment loading behavior for Prisma commands changed (official upgrade guide note). CI/CD and deployment environments must explicitly provide env vars where expected.

Risk:
- Low to medium for existing historical migrations.
- Medium for deployment pipeline behavior if implicitly relying on old env-loading semantics.

---

## 5) Dependency chain / peer constraints

From local dependency graph:
- `@prisma/client` has peer dependency on `prisma` (wildcard), so versions should be kept in lockstep.
- No `@prisma/extension-accelerate` in use.
- No other first-party Prisma extension package constraining Prisma major in this repo.

Important note:
- `package.json` currently has mismatched declared ranges (`@prisma/client` range older than `prisma` range). Even if lockfile resolves currently, this should be normalized during upgrade.

---

## Final recommendation (Go / No-Go)

### Recommendation: **NO-GO for a direct one-step upgrade from v5.22 -> latest v7 in production branch**

Reason:
- v7 introduces structural client/runtime migration requirements (generator removal + adapter requirement) that are non-trivial and high-blast-radius for this codebase.

### Recommendation: **GO for staged upgrade path**
1. First stabilize on latest v6.x.
2. Then plan v7 migration as a dedicated refactor milestone.

This reduces risk and isolates v7-specific breaking work.

---

## Step-by-step upgrade procedure (safe staged path)

## Phase A - Prep
1. Create a dedicated upgrade branch.
2. Align Prisma package declarations (same exact version for `prisma` and `@prisma/client`).
3. Capture baseline:
   - `npx tsc --noEmit`
   - full test suite
   - `prisma migrate status` / deploy dry run in staging

## Phase B - Upgrade to latest v6.x first
4. Bump `prisma` and `@prisma/client` together to latest v6.x.
5. Run:
   - `npx prisma generate`
   - `npx tsc --noEmit`
   - tests
6. Validate critical runtime paths:
   - auth/session flows
   - billing webhooks
   - snapshot jobs
   - any code using Prisma error `instanceof` checks
7. Run `prisma migrate deploy` in staging and verify no migration regressions.

Exit criteria for Phase B:
- Typecheck/tests clean
- staging migrations clean
- no Prisma runtime regressions in smoke tests

## Phase C - v7 migration (dedicated)
8. Migrate schema generator from `prisma-client-js` to `prisma-client` with explicit `output`.
9. Add required SQLite adapter package for v7 and update PrismaClient initialization accordingly.
10. Update all Prisma imports to new generated client path (or centralized export to minimize churn).
11. Re-run generate + typecheck + tests.
12. Validate deploy env behavior (especially env-loading expectations for Prisma commands).
13. Run staging migration/deploy + smoke tests.
14. Roll to production with rollback plan.

---

## Specific checks to add to CI during upgrade
- Guard that `prisma` and `@prisma/client` versions match exactly.
- `prisma generate` + `tsc --noEmit` as explicit CI steps.
- A focused suite for Prisma-heavy paths:
  - billing webhook idempotency
  - auth token rotation/revocation
  - portfolio snapshot creation/cleanup
  - any logic catching `PrismaClientKnownRequestError`.

---

## Bottom line
- Current repo is in a good position for Prisma upgrades generally.
- But direct v5 -> v7 is a high-risk jump due to generator + adapter architecture changes.
- Safest route is staged (`v5 -> v6 -> v7`), with v7 treated as a planned refactor rather than a routine patch bump.
