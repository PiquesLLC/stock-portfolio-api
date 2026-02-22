/**
 * One-time cleanup: remove orphaned entries from _prisma_migrations
 * that reference old migration folders we deleted during re-baseline.
 * Safe to run multiple times (idempotent).
 */
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    // Delete any migration records that aren't our new baseline
    const result = await prisma.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE migration_name != '0001_baseline'`
    );
    console.log(`[clean-migration-history] Removed ${result} orphaned migration records`);
  } catch (e) {
    console.log(`[clean-migration-history] ${e.message}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
