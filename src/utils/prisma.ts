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

export default prisma;
