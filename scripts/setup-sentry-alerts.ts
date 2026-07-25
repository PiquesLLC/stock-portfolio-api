#!/usr/bin/env npx -y ts-node
// One-shot: wire Sentry issue alert rules for v2 reconciliation drift
// and backup failures.
//
// REQUIRES
//   SENTRY_AUTH_TOKEN  — auth token from https://sentry.io/settings/auth-tokens/
//                        Needs scope: `project:write` (or `project:admin`).
//                        Token is one-shot; revoke after running.
//   SENTRY_ORG_SLUG    — your Sentry org's slug (e.g. "nala").
//   SENTRY_PROJECT     — the project slug (default: "nala"). Set if your
//                        project slug differs.
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
  component:
    | 'v2_reconciliation'
    | 'backup'
    | 'offsite_backup'
    | 'db-brownout'
    | 'db-corruption'
    | 'wal-watchdog'
    | 'write-liveness'
    | 'disk_guard'
    | 'snapshot-retention';
}

// Every component below already emits Sentry events from the code; these rules
// route them to a notification. The five DB/disk/backup components are the exact
// precursors to both 2026-07 outages, which previously fired events with NO rule.
const RULES: Rule[] = [
  { name: 'v2 ledger drift', component: 'v2_reconciliation' },
  { name: 'v1 SQLite backup unhealthy / stale', component: 'backup' },
  { name: 'Offsite backup failed', component: 'offsite_backup' },
  { name: 'DB write brownout (P1008 storm)', component: 'db-brownout' },
  { name: 'DB corruption (SQLITE_CORRUPT)', component: 'db-corruption' },
  { name: 'WAL checkpoint starvation', component: 'wal-watchdog' },
  // 2026-07-25: prod was unwritable for 23 minutes and NOTHING alerted — the WAL
  // watchdog early-returns on a small WAL and that outage had a 0-byte one. This
  // rule covers the probe that asks directly whether the write lock is gettable.
  { name: 'SQLite write lock stalled — writes are dead', component: 'write-liveness' },
  { name: 'Disk guard critical', component: 'disk_guard' },
  { name: 'Snapshot retention failed / capped', component: 'snapshot-retention' },
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
    // first_seen + regression ALONE is a silent-failure trap, and it bit us:
    // every occurrence of a given alert folds into ONE issue (the messages are
    // constant strings), so first_seen fires exactly once ever and regression
    // only on a resolved -> unresolved transition. A SECOND occurrence of an
    // already-unresolved issue would notify nobody unless a human had manually
    // resolved it in the UI. For failures whose expected shape is recurrence —
    // the 2026-07-25 write-lock wedge did not reproduce on redeploy and may well
    // come back — that means the first event pages and every one after is
    // silent.
    //
    // event_frequency was previously pruned for fear of spam. That fear does not
    // apply here: the `filters` below scope every rule to ONE component at
    // level >= warning, and `frequency: 30` caps notifications to one per issue
    // per 30 minutes regardless. These components are silent in normal
    // operation, so "seen at all in the last hour" is precisely the signal.
    conditions: [
      { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' },
      { id: 'sentry.rules.conditions.regression_event.RegressionEventCondition' },
      {
        id: 'sentry.rules.conditions.event_frequency.EventFrequencyCondition',
        interval: '1h',
        value: 0, // more than 0 events in the last hour
      },
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
        match: 'gte',
        level: '30', // warning AND ABOVE — so the retention time/chunk-cap (warning)
                     // routes too, not just error. All other ruled components emit
                     // only at error, so this adds no noise.
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
