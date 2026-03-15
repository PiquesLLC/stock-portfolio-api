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

const adapter = new PrismaLibSql({
  url: resolveDbUrl(rawUrl),
});

const prisma = new PrismaClient({ adapter });

// Enable WAL mode + busy timeout for SQLite concurrency.
// WAL allows concurrent reads during writes (default journal mode blocks all).
// busy_timeout makes writers wait up to 5s instead of immediately throwing SQLITE_BUSY.
// Must be awaited before app.listen() and background jobs start.
export async function initSqlitePragmas(): Promise<void> {
  await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
  console.log('[DB] SQLite WAL mode + busy_timeout=5000ms enabled');
}

export default prisma;
