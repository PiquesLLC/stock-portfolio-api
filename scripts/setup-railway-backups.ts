#!/usr/bin/env npx -y ts-node
// One-shot: enable Daily + Weekly volume backups on the Postgres-XF5D
// and stock-portfolio-api volumes via Railway's public GraphQL API.
//
// REQUIRES an Account-scoped or Workspace-scoped Railway token (the
// project token used by the CLI does NOT have permission for the
// `volumeInstanceBackupScheduleUpdate` mutation).
//
// USAGE
//   1. Create or use an Account-scoped token at
//      https://railway.com/account/tokens (name it e.g. `backups-setup`).
//   2. Run: `RAILWAY_TOKEN=<account-token> npx ts-node scripts/setup-railway-backups.ts`
//   3. Revoke the token at the same URL when done.
//
// The script is idempotent: re-running with the same schedules is a no-op
// per Railway's mutation semantics (the same kinds[] just overwrites the
// existing list).
//
// EXIT CODES
//   0  all volumes configured + at least one manual snapshot created
//   1  any mutation failed (read output)

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

interface Volume {
  id: string;
  name: string;
  serviceName: string;
}

// Hard-coded volume metadata (from `railway volume list --json`). The
// IDs are stable per-project and don't change between deploys.
const VOLUMES: Volume[] = [
  { id: '8bc9f02b-2002-49c1-978c-31b12b5a2a92', name: 'postgres-volume-r1qk', serviceName: 'Postgres-XF5D' },
  { id: '0bf35ded-65b7-44ce-b15b-a9635711f061', name: 'stock-portfolio-api-volume-jDWV', serviceName: 'stock-portfolio-api' },
];

async function gql(token: string, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) {
    throw new Error(JSON.stringify(body.errors));
  }
  return body.data;
}

async function main(): Promise<void> {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) {
    console.error('FATAL: RAILWAY_TOKEN env var not set. See script header for instructions.');
    process.exit(1);
  }

  let anyFailure = false;

  for (const vol of VOLUMES) {
    console.log(`\n=== ${vol.name} (${vol.serviceName}) ===`);

    // 1. Enable Daily + Weekly backup schedules.
    try {
      await gql(
        token,
        'mutation($id: String!, $kinds: [VolumeInstanceBackupScheduleKind!]!) { volumeInstanceBackupScheduleUpdate(volumeInstanceId: $id, kinds: $kinds) }',
        { id: vol.id, kinds: ['DAILY', 'WEEKLY'] },
      );
      console.log(`  ✓ schedule set: [DAILY, WEEKLY]`);
    } catch (e) {
      console.error(`  ✗ schedule update failed: ${(e as Error).message}`);
      anyFailure = true;
      continue;
    }

    // 2. Create an immediate manual snapshot tagged with the setup timestamp
    //    so a verifiable baseline exists right now (not waiting for the
    //    cron tick).
    try {
      const name = `setup-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await gql(
        token,
        'mutation($id: String!, $name: String!) { volumeInstanceBackupCreate(volumeInstanceId: $id, name: $name) }',
        { id: vol.id, name },
      );
      console.log(`  ✓ manual baseline backup created: ${name}`);
    } catch (e) {
      console.error(`  ✗ manual backup failed: ${(e as Error).message}`);
      anyFailure = true;
    }
  }

  // 3. Verify by listing schedules + recent backups for each volume.
  console.log('\n=== Verification ===');
  for (const vol of VOLUMES) {
    try {
      const data = (await gql(
        token,
        '{ scheds: volumeInstanceBackupScheduleList(volumeInstanceId: "' +
          vol.id +
          '") { id kind cron retentionSeconds } backups: volumeInstanceBackupList(volumeInstanceId: "' +
          vol.id +
          '") { id name kind createdAt status } }',
      )) as { scheds: Array<{ kind: string; cron: string; retentionSeconds: number | null }>; backups: Array<{ name: string; kind: string; createdAt: string; status: string }> };

      console.log(`\n${vol.name}:`);
      console.log(`  schedules:`);
      for (const s of data.scheds) {
        const days = s.retentionSeconds ? Math.round(s.retentionSeconds / 86400) : null;
        console.log(`    - ${s.kind} (cron='${s.cron}', retention=${days ?? '?'}d)`);
      }
      console.log(`  recent backups:`);
      for (const b of data.backups.slice(0, 5)) {
        console.log(`    - ${b.kind} ${b.name} status=${b.status} at ${b.createdAt}`);
      }
    } catch (e) {
      console.error(`  ✗ verification query failed for ${vol.name}: ${(e as Error).message}`);
      anyFailure = true;
    }
  }

  if (anyFailure) {
    console.error('\nFATAL: at least one operation failed; backups are NOT fully configured.');
    process.exit(1);
  }
  console.log('\n✓ All volumes configured. Revoke the temporary token at https://railway.com/account/tokens.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
