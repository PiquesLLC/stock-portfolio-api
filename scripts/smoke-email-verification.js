#!/usr/bin/env node
/* eslint-disable no-console */
const jwt = require('jsonwebtoken');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3001';
const TEST_HELPER_KEY = process.env.SMOKE_TEST_HELPER_KEY || process.env.TEST_HELPER_KEY || '';
const PROVIDED_VERIFY_CODE = process.env.SMOKE_VERIFY_CODE || '';
const SMOKE_EMAIL = process.env.SMOKE_SIGNUP_EMAIL || `email-smoke-${Date.now()}@example.com`;
const SMOKE_USERNAME = process.env.SMOKE_SIGNUP_USERNAME || `email_smoke_${Date.now().toString(36)}`;
const SMOKE_PASSWORD = process.env.SMOKE_SIGNUP_PASSWORD || 'SmokePass123A';
const SMOKE_DISPLAY_NAME = process.env.SMOKE_SIGNUP_DISPLAY_NAME || 'Email Smoke';
const SMOKE_JWT_SECRET = process.env.SMOKE_JWT_SECRET || '';

const cookieJar = new Map();
let cleanupArmed = false;

function extractSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function storeCookiesFromResponse(response) {
  const setCookies = extractSetCookies(response);
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    cookieJar.set(name, value);
  }
}

function buildCookieHeader(extra = {}) {
  const merged = new Map(cookieJar);
  for (const [k, v] of Object.entries(extra)) {
    merged.set(k, v);
  }
  return Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function requestJson(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { ...(options.headers || {}) };
  const useAuthCookies = options.withCookies !== false;
  const cookieOverride = options.cookieOverride || null;
  const persistCookies = options.persistCookies !== false;
  if (cookieOverride) {
    headers.Cookie = cookieOverride;
  } else if (useAuthCookies && cookieJar.size > 0) {
    headers.Cookie = buildCookieHeader();
  }
  const response = await fetch(url, { ...options, headers });
  if (persistCookies) {
    storeCookiesFromResponse(response);
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text || null;
  }
  return { response, body };
}

function fail(message, data) {
  if (data !== undefined) {
    console.error(`[FAIL] ${message}`);
    console.error(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } else {
    console.error(`[FAIL] ${message}`);
  }
  process.exitCode = 1;
  throw new Error(message);
}

function pass(message) {
  console.log(`[PASS] ${message}`);
}

async function expectStatus(path, options, acceptedStatuses, label) {
  const { response, body } = await requestJson(path, options);
  if (!acceptedStatuses.includes(response.status)) {
    fail(`${label} -> ${response.status} (expected ${acceptedStatuses.join('/')})`, body);
  }
  return { response, body };
}

async function resolveVerificationCode(email) {
  if (PROVIDED_VERIFY_CODE) {
    pass('Using SMOKE_VERIFY_CODE from env');
    return PROVIDED_VERIFY_CODE;
  }

  if (!TEST_HELPER_KEY) {
    fail(
      'No verification code source available. Set SMOKE_VERIFY_CODE or TEST_HELPER_KEY/SMOKE_TEST_HELPER_KEY.'
    );
  }

  const { response, body } = await requestJson(
    `/auth/test/verification-code?email=${encodeURIComponent(email)}`,
    {
      method: 'GET',
      withCookies: false,
      headers: { 'x-test-helper-key': TEST_HELPER_KEY },
    }
  );

  if (response.status !== 200 || typeof body?.code !== 'string') {
    fail(
      'Failed to fetch OTP from /auth/test/verification-code (helper only works in non-production with correct key).',
      body
    );
  }

  pass('Fetched OTP from /auth/test/verification-code');
  return body.code;
}

function maybeBuildExpiredAccessToken() {
  if (!SMOKE_JWT_SECRET) {
    console.log('[SKIP] Expired token check skipped (set SMOKE_JWT_SECRET to enable).');
    return null;
  }
  return jwt.sign(
    {
      userId: 'smoke-expired-user',
      username: 'smoke_expired',
      plan: 'free',
      planExpiresAt: null,
      emailVerified: true,
    },
    SMOKE_JWT_SECRET,
    { expiresIn: -60 }
  );
}

async function cleanupAccount() {
  if (!cleanupArmed) return;
  try {
    const { response, body } = await requestJson('/auth/delete-account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: SMOKE_PASSWORD }),
    });
    if (response.status === 200) {
      pass('Cleanup: deleted smoke-test account');
      cleanupArmed = false;
      return;
    }
    console.warn(`[WARN] Cleanup failed with status ${response.status}`);
    if (body) console.warn(JSON.stringify(body, null, 2));
  } catch (error) {
    console.warn('[WARN] Cleanup threw error:', error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  console.log('=== Email Verification Smoke Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Signup Email: ${SMOKE_EMAIL}`);
  console.log(`Signup Username: ${SMOKE_USERNAME}`);
  console.log('');

  try {
    const signupPayload = {
      username: SMOKE_USERNAME,
      email: SMOKE_EMAIL,
      displayName: SMOKE_DISPLAY_NAME,
      password: SMOKE_PASSWORD,
      acceptedPrivacyPolicy: true,
      acceptedTerms: true,
    };
    const signup = await expectStatus(
      '/auth/signup',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signupPayload),
        withCookies: false,
      },
      [201],
      'POST /auth/signup'
    );
    cleanupArmed = true;
    if (signup.body?.emailVerificationRequired !== true) {
      fail('Expected signup response to set emailVerificationRequired=true', signup.body);
    }
    pass('POST /auth/signup created unverified account');

    const meBefore = await expectStatus('/auth/me', { method: 'GET' }, [200], 'GET /auth/me (before verify)');
    if (meBefore.body?.emailVerified !== false) {
      fail('Expected /auth/me emailVerified=false before OTP verification', meBefore.body);
    }
    pass('GET /auth/me confirms emailVerified=false');

    const guardedBefore = await expectStatus('/watchlists', { method: 'GET' }, [403], 'GET /watchlists (before verify)');
    if (guardedBefore.body?.code !== 'EMAIL_NOT_VERIFIED') {
      fail('Expected EMAIL_NOT_VERIFIED before verification when hitting guarded route', guardedBefore.body);
    }
    pass('Guarded route blocked unverified account with EMAIL_NOT_VERIFIED');

    const invalidAccess = await expectStatus(
      '/watchlists',
      {
        method: 'GET',
        withCookies: false,
        persistCookies: false,
        cookieOverride: 'authToken=definitely-invalid; refreshToken=definitely-invalid',
      },
      [401],
      'GET /watchlists with invalid access token'
    );
    if (invalidAccess.body?.code !== 'TOKEN_INVALID') {
      fail('Expected TOKEN_INVALID for malformed access token', invalidAccess.body);
    }
    pass('Invalid access token rejected with TOKEN_INVALID');

    await expectStatus(
      '/auth/resend-verification',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: SMOKE_EMAIL }),
      },
      [200, 429],
      'POST /auth/resend-verification'
    );
    pass('Resend verification endpoint reachable');

    const validCode = await resolveVerificationCode(SMOKE_EMAIL);
    const invalidCode = validCode === '000000' ? '999999' : '000000';

    const invalidOtp = await expectStatus(
      '/auth/verify-email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: invalidCode }),
      },
      [400],
      'POST /auth/verify-email with invalid code'
    );
    if (typeof invalidOtp.body?.error !== 'string' || !invalidOtp.body.error.toLowerCase().includes('invalid')) {
      fail('Expected invalid OTP response to include invalid/expired message', invalidOtp.body);
    }
    pass('Invalid OTP rejected');

    await expectStatus(
      '/auth/verify-email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: validCode }),
      },
      [200],
      'POST /auth/verify-email with valid code'
    );
    pass('Valid OTP accepted');

    const meAfter = await expectStatus('/auth/me', { method: 'GET' }, [200], 'GET /auth/me (after verify)');
    if (meAfter.body?.emailVerified !== true) {
      fail('Expected /auth/me emailVerified=true after OTP verification', meAfter.body);
    }
    pass('GET /auth/me confirms emailVerified=true');

    const guardedAfter = await expectStatus('/watchlists', { method: 'GET' }, [200], 'GET /watchlists (after verify)');
    if (!Array.isArray(guardedAfter.body)) {
      fail('Expected watchlists payload to be an array after verification', guardedAfter.body);
    }
    pass('Guarded route unlocked after verification');

    const invalidRefresh = await expectStatus(
      '/auth/refresh',
      {
        method: 'POST',
        withCookies: false,
        persistCookies: false,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'invalid-refresh-token' }),
      },
      [401],
      'POST /auth/refresh with invalid token'
    );
    if (invalidRefresh.body?.code !== 'TOKEN_INVALID') {
      fail('Expected TOKEN_INVALID for invalid refresh token', invalidRefresh.body);
    }
    pass('Invalid refresh token rejected with TOKEN_INVALID');

    const expiredToken = maybeBuildExpiredAccessToken();
    if (expiredToken) {
      const expiredAccess = await expectStatus(
        '/watchlists',
        {
          method: 'GET',
          withCookies: false,
          persistCookies: false,
          cookieOverride: `authToken=${expiredToken}; refreshToken=dummy-refresh-token`,
        },
        [401],
        'GET /watchlists with expired access token'
      );
      if (expiredAccess.body?.code !== 'TOKEN_EXPIRED') {
        fail('Expected TOKEN_EXPIRED for expired access token', expiredAccess.body);
      }
      pass('Expired access token rejected with TOKEN_EXPIRED');
    }
  } finally {
    await cleanupAccount();
  }

  console.log('');
  console.log('Email verification smoke test PASSED.');
}

main().catch((error) => {
  console.error('');
  console.error('Email verification smoke test FAILED.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
