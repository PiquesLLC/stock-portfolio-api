#!/usr/bin/env npx -y ts-node
// One-shot: wire Sentry issue alert rules for v2 reconciliation drift
// and backup failures.
//
// REQUIRES
//   SENTRY_AUTH_TOKEN  — auth token from https://sentry.io/settings/auth-tokens/
//                        Needs scope: `project:write` (or `project:admin`).
//                        Token is one-shot; revoke after running.
//   SENTRY_ORG_SLUG    — your Sentry org's slug (e.g. "nala").
//   SENTRY_PROJECT     — the project slug (e.g. "nala-api"). Defaults to
//                        "nala-api" — set explicitly if different.
//
// USAGE
//   SENTRY_AUTH_TOKEN=<token> SENTRY_ORG_SLUG=<org> \
//     npx ts-node scripts/setup-sentry-alerts.ts
//
// IDEMPOTENT: if a rule with the same name already exists, the script
// PATCHes it instead of creating a duplicate.

const SENTRY_API = 'https://sentry.io/api/0';

interface Rule {
  name: string;
  component: 'v2_reconciliation' | 'backup';
}

const RULES: Rule[] = [
  { name: 'v2 ledger drift', component: 'v2_reconciliation' },
  { name: 'v1 SQLite backup unhealthy', component: 'backup' },
];

async function sentry(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${SENTRY_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sentry ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function ruleBody(name: string, component: string): unknown {
  return {
    name,
    owner: null,
    environment: null,
    actionMatch: 'any',
    filterMatch: 'all',
    frequency: 30, // minutes — "notify at most once per N minutes per issue"
    // Only first_seen + regression. event_frequency would spam (every issue
    // that fires >1/min triggers); reappeared would page on revived old
    // issues during a transient blip. Both pruned per reviewer.
    conditions: [
      { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' },
      { id: 'sentry.rules.conditions.regression_event.RegressionEventCondition' },
    ],
    filters: [
      {
        id: 'sentry.rules.filters.tagged_event.TaggedEventFilter',
        key: 'component',
        match: 'eq',
        value: component,
      },
      {
        id: 'sentry.rules.filters.level.LevelFilter',
        match: 'eq',
        level: '40', // error
      },
    ],
    actions: [
      // Default: notify the project's default team via Sentry's email plugin.
      // Edit in Sentry UI to swap for Slack / PagerDuty integrations once those
      // are connected.
      {
        id: 'sentry.mail.actions.NotifyEmailAction',
        targetType: 'IssueOwners',
        targetIdentifier: null,
      },
    ],
  };
}

async function main(): Promise<void> {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG_SLUG;
  const project = process.env.SENTRY_PROJECT || 'nala';
  if (!token || !org) {
    console.error('FATAL: set SENTRY_AUTH_TOKEN and SENTRY_ORG_SLUG. See script header.');
    process.exit(1);
  }

  // 1. List existing rules to dedupe.
  const existing = (await sentry(token, `/projects/${org}/${project}/rules/`)) as Array<{ id: string; name: string }>;
  console.log(`Found ${existing.length} existing rules in ${org}/${project}.`);

  for (const rule of RULES) {
    const body = ruleBody(rule.name, rule.component);
    const match = existing.find((r) => r.name === rule.name);
    if (match) {
      console.log(`  ↻ updating existing rule "${rule.name}" (id=${match.id})`);
      await sentry(token, `/projects/${org}/${project}/rules/${match.id}/`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    } else {
      console.log(`  + creating rule "${rule.name}"`);
      await sentry(token, `/projects/${org}/${project}/rules/`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
  }

  console.log('\n✓ Sentry alert rules synced. Revoke the auth token at https://sentry.io/settings/auth-tokens/.');
  console.log('  Edit the rules in Sentry UI to swap the default email action for Slack/PagerDuty when those integrations are connected.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
