#!/bin/bash
# Railway build script: builds the API and the UI client
set -e

echo "=== Building API ==="
npm install --include=dev
npx prisma generate
npx tsc

echo "=== Building UI Client ==="
# Clone and build the UI
git clone --depth 1 https://github.com/PiquesLLC/stock-portfolio-ui.git /tmp/ui-build
cd /tmp/ui-build

# Inject VITE_ env vars for the production build
echo "VITE_API_URL=" > .env.production
[ -n "$VITE_ADMIN_USER_ID" ] && echo "VITE_ADMIN_USER_ID=$VITE_ADMIN_USER_ID" >> .env.production
[ -n "$VITE_WAITLIST_ENABLED" ] && echo "VITE_WAITLIST_ENABLED=$VITE_WAITLIST_ENABLED" >> .env.production
[ -n "$VITE_GOOGLE_CLIENT_ID" ] && echo "VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID" >> .env.production
[ -n "$VITE_APPLE_CLIENT_ID" ] && echo "VITE_APPLE_CLIENT_ID=$VITE_APPLE_CLIENT_ID" >> .env.production
npm install
npx vite build

# Copy built UI to the API's client directory
cp -r dist $OLDPWD/client
cd $OLDPWD
rm -rf /tmp/ui-build

echo "=== Build complete ==="
ls -la client/
