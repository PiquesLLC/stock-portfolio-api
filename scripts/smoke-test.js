#!/usr/bin/env node
/* eslint-disable no-console */
const BASE_URL = process.env.SMOKE_BASE_URL || 'https://stock-portfolio-api-production.up.railway.app';

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

async function main() {
  console.log('=== Post-Deploy Smoke Test ===');
  console.log(`Base URL: ${BASE_URL}`);
  console.log('');

  const checks = [
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
      acceptedStatus: [400],
    },
    {
      name: 'Portfolio auth gating',
      method: 'GET',
      path: '/portfolio/holdings',
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

  console.log('');
  if (failures > 0) {
    console.log(`Smoke test FAILED: ${failures} check(s) did not match expected status.`);
    process.exit(1);
  }
  console.log('Smoke test PASSED: all checks matched expected status.');
  process.exit(0);
}

main();
