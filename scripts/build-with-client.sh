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

# Set the API URL to empty string (same origin in production)
echo "VITE_API_URL=" > .env.production
npm install
npx vite build

# Copy built UI to the API's client directory
cp -r dist $OLDPWD/client
cd $OLDPWD
rm -rf /tmp/ui-build

echo "=== Build complete ==="
ls -la client/
