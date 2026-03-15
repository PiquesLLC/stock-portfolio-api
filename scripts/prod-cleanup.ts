import prisma from '../src/utils/prisma';

type SqliteChangesRow = {
  count: number;
};

type WalCheckpointRow = {
  busy: number;
  log: number;
  checkpointed: number;
};

async function getChanges(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<SqliteChangesRow[]>('SELECT changes() AS count');
  return Number(rows[0]?.count ?? 0);
}

async function executeDelete(sql: string, label: string): Promise<number> {
  await prisma.$executeRawUnsafe(sql);
  const deleted = await getChanges();
  console.log(`${label}: deleted ${deleted}`);
  return deleted;
}

async function main(): Promise<void> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  console.log('Starting production SQLite cleanup...');
  console.log(`Current time: ${now.toISOString()}`);

  await executeDelete(
    `DELETE FROM "RefreshToken" WHERE "expiresAt" < '${now.toISOString()}' OR "revokedAt" IS NOT NULL`,
    'RefreshToken expired/revoked cleanup',
  );

  await executeDelete(
    `DELETE FROM "JobIdempotencyKey" WHERE "expiresAt" < '${now.toISOString()}'`,
    'JobIdempotencyKey expired cleanup',
  );

  await executeDelete(
    `DELETE FROM "BackgroundJobRun" WHERE "startedAt" < '${sevenDaysAgo}'`,
    'BackgroundJobRun older than 7 days cleanup',
  );

  let holdingSnapshotTotalDeleted = 0;
  let chunkNumber = 0;

  while (true) {
    chunkNumber += 1;
    await prisma.$executeRawUnsafe(
      `DELETE FROM "HoldingSnapshot"
       WHERE "id" IN (
         SELECT "id"
         FROM "HoldingSnapshot"
         WHERE "timestamp" < '${thirtyDaysAgo}'
         ORDER BY "timestamp" ASC
         LIMIT 5000
       )`,
    );

    const deleted = await getChanges();
    holdingSnapshotTotalDeleted += deleted;
    console.log(`HoldingSnapshot chunk ${chunkNumber}: deleted ${deleted}`);

    if (deleted === 0) {
      break;
    }
  }

  console.log(`HoldingSnapshot older than 30 days cleanup: deleted ${holdingSnapshotTotalDeleted} total`);

  const checkpointRows = await prisma.$queryRawUnsafe<WalCheckpointRow[]>('PRAGMA wal_checkpoint(TRUNCATE)');
  const checkpoint = checkpointRows[0];
  console.log(
    `wal_checkpoint(TRUNCATE): busy=${Number(checkpoint?.busy ?? 0)} log=${Number(
      checkpoint?.log ?? 0,
    )} checkpointed=${Number(checkpoint?.checkpointed ?? 0)}`,
  );

  try {
    await prisma.$executeRawUnsafe('VACUUM');
    console.log('VACUUM: succeeded');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`VACUUM: skipped due to error: ${message}`);
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error('Cleanup failed:', message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('Prisma disconnected');
    process.exit(process.exitCode ?? 0);
  });
