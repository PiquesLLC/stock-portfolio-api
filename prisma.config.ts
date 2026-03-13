import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import path from 'path';

const rawUrl = process.env.DATABASE_URL ?? 'file:./dev.db';

function resolveCliDbUrl(url: string): string {
  if (!url.startsWith('file:./')) return url;
  return `file:${path.resolve(process.cwd(), 'prisma', url.slice(7))}`;
}

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    url: resolveCliDbUrl(rawUrl),
  },
});
