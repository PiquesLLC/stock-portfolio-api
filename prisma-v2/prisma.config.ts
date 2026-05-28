// Prisma 7 config for the v2 Postgres ledger schema.
//
// The root prisma.config.ts pins schema=prisma/schema.prisma + the v1 libsql
// DATABASE_URL — running `prisma migrate` against the v2 schema with that
// config would silently target the v1 DB (catastrophic). This config exists
// so v2 npm scripts can select it via `--config=./prisma-v2/prisma.config.ts`
// and have Prisma read the v2 datasource URL.
//
// The placeholder fallback prevents `prisma generate` from erroring when
// V2_DATABASE_URL is unset (e.g. on Railway build with no v2 Postgres
// provisioned yet). Generate does not connect — it only validates the URL
// shape — so a placeholder is safe at build time. At runtime, the live URL
// is read in src/v2/ledger/prisma.ts and passed to the adapter directly.

import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import path from 'path';

const rawUrl =
  process.env.V2_DATABASE_URL ??
  'postgresql://placeholder:placeholder@localhost:5432/placeholder';

// Resolve schema path relative to this config file so npm scripts work
// regardless of cwd. Prisma resolves the `schema` field relative to the
// config file's directory.
export default defineConfig({
  earlyAccess: true,
  schema: path.resolve(__dirname, 'schema.prisma'),
  datasource: {
    url: rawUrl,
  },
});
