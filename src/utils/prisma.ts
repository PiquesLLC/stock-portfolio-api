import path from 'path';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from '../generated/prisma/client';

const rawUrl = process.env.DATABASE_URL || 'file:./dev.db';

// libsql resolves file: paths relative to CWD, but Prisma CLI resolves
// relative to the schema directory (prisma/). Align them so both use the
// same database file. Production uses absolute paths and is unaffected.
function resolveDbUrl(url: string): string {
  if (!url.startsWith('file:./')) return url;
  const rel = url.slice(7);
  return `file:${path.resolve(__dirname, '../../prisma', rel)}`;
}

/**
 * The database URL/file Prisma ACTUALLY opens, exported so other components
 * cannot drift onto a different file.
 *
 * backup.service's DB_PATH derives its own path by stripping `file:`, which in
 * dev yields `<root>/dev.db` while Prisma opens `<root>/prisma/dev.db`. A
 * stray empty `<root>/dev.db` already exists in this repo as evidence. Anything
 * that must talk to the SAME database the app uses — notably the write-liveness
 * probe, where hitting the wrong file means reporting healthy against a
 * database nobody uses — should import this.
 */
export const RESOLVED_DB_URL = resolveDbUrl(rawUrl);
export const RESOLVED_DB_FILE = RESOLVED_DB_URL.replace(/^file:/, '');

const adapter = new PrismaLibSql({
  url: RESOLVED_DB_URL,
});

const prisma = new PrismaClient({ adapter });

// Enable WAL mode + busy timeout for SQLite concurrency.
// WAL allows concurrent reads during writes (default journal mode blocks all).
// busy_timeout makes writers wait up to 5s instead of immediately throwing SQLITE_BUSY.
// Must be awaited before app.listen() and background jobs start.
export async function initSqlitePragmas(): Promise<void> {
  await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
  // Return freed pages to the OS so row deletes actually shrink the file. Only takes
  // effect after the first full VACUUM (the disk guard runs one when reclaiming); until
  // then it is inert, so setting it unconditionally on every connect is safe.
  await prisma.$executeRawUnsafe('PRAGMA auto_vacuum = INCREMENTAL');
  console.log('[DB] SQLite WAL mode + busy_timeout=5000ms + auto_vacuum=INCREMENTAL enabled');
}

export default prisma;
