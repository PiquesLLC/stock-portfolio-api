#!/usr/bin/env node
const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3001';
const isLocalBaseUrl = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(BASE_URL);
const BILLING_ENABLED = String(process.env.BILLING_ENABLED ?? (isLocalBaseUrl ? 'false' : 'true')).toLowerCase() !== 'false';
const RUN_SIGNUP_FLOW = String(process.env.SMOKE_RUN_SIGNUP_FLOW ?? 'false').toLowerCase() === 'true';
const SIGNUP_EMAIL = process.env.SMOKE_SIGNUP_EMAIL || '';
const VERIFY_CODE = process.env.SMOKE_VERIFY_CODE || '';
const TEST_HELPER_KEY = process.env.TEST_HELPER_KEY || '';
const SIGNUP_PASSWORD = process.env.SMOKE_SIGNUP_PASSWORD || 'StrongPass123';

function parseSetCookies(setCookies) {
  if (!Array.isArray(setCookies)) return '';
  return setCookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function runCheck(check) {
  const url = `${BASE_URL}${check.path}`;
  const headers = { ...(check.headers || {}) };
  const init = {
    method: check.method,
    headers,
  };
  if (check.body !== undefined) {
    init.body = check.body;
  }

  try {
    const response = await fetch(url, init);
    const ok = check.acceptedStatus.includes(response.status);
    return {
      name: check.name,
      method: check.method,
      path: check.path,
      status: response.status,
      ok,
      expected: check.acceptedStatus.join('/'),
    };
  } catch (error) {
    return {
      name: check.name,
      method: check.method,
      path: check.path,
      status: 'ERR',
      ok: false,
      expected: check.acceptedStatus.join('/'),
    };
  }
}

async function requestJson(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

async function runSignupVerificationFlow() {
  const username = `smoke_${Date.now().toString(36)}`;
  const email = SIGNUP_EMAIL;
  const password = SIGNUP_PASSWORD;
  let cookies = '';
  let failures = 0;

  if (!email) {
    console.log('[SKIP] Signup verification flow skipped (set SMOKE_RUN_SIGNUP_FLOW=true and SMOKE_SIGNUP_EMAIL=...)');
    return 0;
  }

  console.log('');
  console.log('=== Signup Verification Flow ===');

  const signup = await requestJson('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      email,
      displayName: 'Smoke User',
      password,
      acceptedPrivacyPolicy: true,
      acceptedTerms: true,
    }),
  });

  if (signup.response.status !== 201) {
    console.log(`[FAIL] POST /auth/signup -> ${signup.response.status} (expected 201)`);
    return 1;
  }
  cookies = parseSetCookies(signup.response.headers.getSetCookie?.() || []);
  console.log(`[PASS] POST /auth/signup -> ${signup.response.status}`);

  const preVerifyAi = await requestJson('/insights/briefing', {
    method: 'GET',
    headers: cookies ? { Cookie: cookies } : {},
  });
  const preVerifyStatusOk = [402, 403].includes(preVerifyAi.response.status);
  const preVerifyBlockedByEmail =
    preVerifyAi.response.status === 403 && preVerifyAi.body?.error === 'email_verification_required';
  if (!preVerifyStatusOk) {
    console.log(`[FAIL] GET /insights/briefing before verify -> ${preVerifyAi.response.status} (expected 402/403)`);
    failures += 1;
  } else {
    console.log(
      `[PASS] GET /insights/briefing before verify -> ${preVerifyAi.response.status}` +
      (preVerifyBlockedByEmail ? ' (email gate active)' : ' (plan gate active)')
    );
  }

  const resend = await requestJson('/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (![200, 429].includes(resend.response.status)) {
    console.log(`[FAIL] POST /auth/resend-verification -> ${resend.response.status} (expected 200/429)`);
    failures += 1;
  } else {
    console.log(`[PASS] POST /auth/resend-verification -> ${resend.response.status}`);
  }

  let verificationCode = VERIFY_CODE;
  if (!verificationCode) {
    const helperHeaders = {};
    if (TEST_HELPER_KEY) {
      helperHeaders['x-test-helper-key'] = TEST_HELPER_KEY;
    }
    const helper = await requestJson(`/auth/test/verification-code?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: helperHeaders,
    });
    if (helper.response.status === 200 && typeof helper.body?.code === 'string') {
      verificationCode = helper.body.code;
      console.log('[PASS] GET /auth/test/verification-code -> 200');
    }
  }

  if (!verificationCode) {
    console.log('[SKIP] Verification step skipped (set SMOKE_VERIFY_CODE or enable /auth/test/verification-code helper)');
  } else {
    const verify = await requestJson('/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: verificationCode }),
    });
    if (verify.response.status !== 200) {
      console.log(`[FAIL] POST /auth/verify-email -> ${verify.response.status} (expected 200)`);
      failures += 1;
    } else {
      console.log('[PASS] POST /auth/verify-email -> 200');
    }

    const postVerifyAi = await requestJson('/insights/briefing', {
      method: 'GET',
      headers: cookies ? { Cookie: cookies } : {},
    });
    const stillEmailBlocked =
      postVerifyAi.response.status === 403 && postVerifyAi.body?.error === 'email_verification_required';
    if (stillEmailBlocked) {
      console.log('[FAIL] GET /insights/briefing after verify -> still blocked by email verification');
      failures += 1;
    } else {
      console.log(
        `[PASS] GET /insights/briefing after verify -> ${postVerifyAi.response.status} ` +
        '(no email verification block)'
      );
    }
  }

  if (cookies) {
    await requestJson('/auth/delete-account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookies },
      body: JSON.stringify({ password }),
    });
  }

  return failures;
}

async function main() {
  console.log('=== Post-Deploy Smoke Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Billing enabled expectation: ${BILLING_ENABLED}`);
  console.log(`Signup verification flow: ${RUN_SIGNUP_FLOW}`);
  console.log('');

  const checks = [
    {
      name: 'Health check',
      method: 'GET',
      path: '/health',
      acceptedStatus: [200],
    },
    {
      name: 'Auth middleware',
      method: 'GET',
      path: '/auth/me',
      acceptedStatus: [401],
    },
    {
      name: 'Market quote pipeline',
      method: 'GET',
      path: '/market/quote/AAPL',
      acceptedStatus: [200],
    },
    {
      name: 'Heatmap pipeline',
      method: 'GET',
      path: '/market/heatmap',
      acceptedStatus: [200],
    },
    {
      name: 'Billing webhook signature guard',
      method: 'POST',
      path: '/billing/webhook',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_smoke_no_sig', type: 'checkout.session.completed', data: { object: {} } }),
      acceptedStatus: BILLING_ENABLED ? [400] : [404],
    },
    {
      name: 'Portfolio route auth gate',
      method: 'GET',
      path: '/portfolio',
      acceptedStatus: [401],
    },
    {
      name: 'Insights plan/auth gate',
      method: 'GET',
      path: '/insights/briefing',
      acceptedStatus: [401, 403],
    },
  ];

  let failures = 0;
  for (const check of checks) {
    const result = await runCheck(check);
    const tag = result.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${result.method} ${result.path} (${check.name}) -> ${result.status} (expected ${result.expected})`);
    if (!result.ok) failures += 1;
  }

  if (RUN_SIGNUP_FLOW) {
    failures += await runSignupVerificationFlow();
  }

  console.log('');
  if (failures > 0) {
    console.log(`Smoke test FAILED: ${failures} check(s) did not match expected status.`);
    process.exitCode = 1;
    return;
  }
  console.log('Smoke test PASSED: all checks matched expected status.');
}

main();
