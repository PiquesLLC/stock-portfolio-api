#!/bin/bash
# Railway build script: builds the API and the UI client
# UI build rev: 202
set -e

echo "=== Building API ==="
npm install --include=dev
# v1 client (libsql/SQLite). Default schema at prisma/schema.prisma.
npx prisma generate
# v2 client (Postgres ledger). Generated to src/generated/prisma-v2/ —
# required by src/v2/ledger/*.ts. The v2 module is NOT loaded at runtime
# on Railway (no caller imports from src/v2 yet), but tsc compiles all
# .ts files in src/, so the type declarations must exist for the build
# to succeed.
#
# Uses prisma-v2/prisma.config.ts (selected via --config) for schema and
# datasource URL. The config provides a placeholder fallback when
# V2_DATABASE_URL is unset, so this generate succeeds on Railway even
# without v2 Postgres provisioned. The real V2_DATABASE_URL is required
# at runtime once any caller invokes getLedgerClient().
npx prisma generate --config=./prisma-v2/prisma.config.ts
npx tsc

echo "=== Building UI Client ==="
# Clone and build the UI (force fresh clone every deploy)
rm -rf /tmp/ui-build
git clone --branch master --single-branch --depth 1 https://github.com/PiquesLLC/stock-portfolio-ui.git /tmp/ui-build
echo "UI commit: $(cd /tmp/ui-build && git rev-parse HEAD)"
cd /tmp/ui-build

# Inject VITE_ env vars for the production build
echo "VITE_API_URL=" > .env.production
[ -n "$VITE_ADMIN_USER_ID" ] && echo "VITE_ADMIN_USER_ID=$VITE_ADMIN_USER_ID" >> .env.production
[ -n "$VITE_WAITLIST_ENABLED" ] && echo "VITE_WAITLIST_ENABLED=$VITE_WAITLIST_ENABLED" >> .env.production
[ -n "$VITE_GOOGLE_CLIENT_ID" ] && echo "VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID" >> .env.production
[ -n "$VITE_APPLE_CLIENT_ID" ] && echo "VITE_APPLE_CLIENT_ID=$VITE_APPLE_CLIENT_ID" >> .env.production
[ -n "$VITE_APPLE_REDIRECT_URI" ] && echo "VITE_APPLE_REDIRECT_URI=$VITE_APPLE_REDIRECT_URI" >> .env.production
# --include=dev: Railway sets NODE_ENV=production, which makes npm skip
# devDependencies. Vite + plugin-react live in devDependencies, so without
# this flag `npx vite build` runs against an empty install. Broke prod
# builds Apr 28 → May 1.
npm install --include=dev
npx vite build

# Copy built UI to the API's client directory
cp -r dist $OLDPWD/client
cd $OLDPWD
rm -rf /tmp/ui-build

echo "=== Build complete ==="
ls -la client/
