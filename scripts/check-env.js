#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const envExamplePath = path.join(ROOT, '.env.example');
const envPath = path.join(ROOT, '.env');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
}

function parseExampleKeys(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error('FAIL: .env.example not found at repo root');
    process.exit(1);
  }
  const keys = [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    keys.push(key);
  }
  return keys;
}

const exampleKeys = parseExampleKeys(envExamplePath);
const envVars = { ...readEnvFile(envPath), ...process.env };

const optionalKeys = new Set([
  'JWT_REFRESH_SECRET',
  'READ_ONLY',
  'BILLING_ENABLED',
  'ALLOWED_ORIGINS',
  'AV_DAILY_LIMIT',
  'RESEND_API_KEY',
  'STRIPE_PRO_YEARLY_PRICE_ID',
  'STRIPE_PREMIUM_YEARLY_PRICE_ID',
  'SP500_CAGR_TOTAL_RETURN',
  'RISK_FREE_RATE',
  'REFRESH_TOKEN_EXPIRES_IN_DAYS',
  'CLEANUP_MIGRATED_HOLDINGS',
]);

const missingFromEnv = exampleKeys.filter(
  (key) => !optionalKeys.has(key) && (!(key in envVars) || String(envVars[key]).trim() === '')
);
const extraInEnv = Object.keys(envVars).filter((key) => !exampleKeys.includes(key));

const billingEnabled = String(envVars.BILLING_ENABLED ?? 'true').toLowerCase() !== 'false';
const criticalAlways = [
  'DATABASE_URL',
  'JWT_SECRET',
  'FINNHUB_API_KEY',
  'POLYGON_API_KEY',
  'MFA_ENCRYPTION_KEY',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
];
const criticalBilling = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRO_MONTHLY_PRICE_ID',
  'STRIPE_PREMIUM_MONTHLY_PRICE_ID',
];
const criticalKeys = billingEnabled ? [...criticalAlways, ...criticalBilling] : criticalAlways;
const missingCritical = criticalKeys.filter((key) => !(key in envVars) || String(envVars[key]).trim() === '');

console.log('=== Environment Parity Check ===');
console.log(`Source of truth: ${envExamplePath}`);
console.log(`Checked runtime env + ${fs.existsSync(envPath) ? '.env' : '(no .env file found)'}`);
console.log(`Billing enabled: ${billingEnabled}`);
console.log('');

if (missingFromEnv.length === 0) {
  console.log('PASS: All required .env.example keys are present in current environment.');
} else {
  console.log(`WARN: ${missingFromEnv.length} required .env.example keys are missing values.`);
  for (const key of missingFromEnv) {
    console.log(`  - ${key}`);
  }
}

if (missingCritical.length === 0) {
  console.log('PASS: All critical keys for startup are present.');
} else {
  console.log(`FAIL: Missing ${missingCritical.length} critical startup keys:`);
  for (const key of missingCritical) {
    console.log(`  - ${key}`);
  }
}

if (extraInEnv.length > 0) {
  console.log(`INFO: ${extraInEnv.length} additional env vars exist beyond .env.example.`);
}

if (missingCritical.length > 0) {
  process.exit(1);
}

process.exit(0);
