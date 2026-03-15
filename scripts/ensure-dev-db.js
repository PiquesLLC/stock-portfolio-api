#!/usr/bin/env node
// Ensures local SQLite dev DB contains the background job reliability tables.
// This avoids destructive schema pushes while keeping `npm run dev` bootable.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

function resolveDbUrl(rawUrl) {
  if (!rawUrl || !rawUrl.startsWith('file:./')) return rawUrl;
  const rel = rawUrl.slice('file:./'.length);
  return `file:${path.resolve(__dirname, '../prisma', rel)}`;
}

function splitSqlStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}

async function tableExists(client, tableName) {
  const result = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function applyMigrationFile(client, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  for (const statement of splitSqlStatements(sql)) {
    await client.execute(statement);
  }
}

async function main() {
  const dbUrl = resolveDbUrl(process.env.DATABASE_URL || 'file:./dev.db');
  if (!dbUrl || !dbUrl.startsWith('file:')) {
    return;
  }

  const client = createClient({ url: dbUrl });
  const requiredTables = [
    {
      name: 'BackgroundJobRun',
      migration: path.resolve(__dirname, '../prisma/migrations/20260310_add_job_reliability/migration.sql'),
    },
    {
      name: 'DeadLetterEntry',
      migration: path.resolve(__dirname, '../prisma/migrations/20260310_add_job_reliability/migration.sql'),
    },
    {
      name: 'JobIdempotencyKey',
      migration: path.resolve(__dirname, '../prisma/migrations/20260311_add_job_idempotency/migration.sql'),
    },
  ];

  const missing = [];
  for (const table of requiredTables) {
    if (!(await tableExists(client, table.name))) {
      missing.push(table);
    }
  }

  if (missing.length === 0) {
    await client.close();
    return;
  }

  const migrations = Array.from(new Set(missing.map((table) => table.migration)));
  for (const migration of migrations) {
    await applyMigrationFile(client, migration);
  }

  console.log(`[DevDB] Added missing tables: ${missing.map((table) => table.name).join(', ')}`);
  await client.close();
}

main().catch((error) => {
  console.error('[DevDB] Failed to ensure local dev DB:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
