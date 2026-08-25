/* eslint-disable no-console */
import {
  requeueParkedAppleReconciliations,
  countParkedAppleReconciliations,
  RequeueScopeError,
} from '../src/services/apple-parked-recovery';
import type { AppleEnvironment } from '../src/services/apple-reconciliation-queue.service';

/**
 * Operator recovery for parked Apple reconciliation jobs.
 *
 *   npm run apple:requeue-parked -- --environment Production
 *   npm run apple:requeue-parked -- --original-transaction-id 2000000123456789
 *   npm run apple:requeue-parked -- --all
 *
 * Use after fixing a cause that parked rows through no fault of Apple's — a
 * wrong APPLE_BUNDLE_ID, bad IAP credentials, a stale root certificate, a
 * verifier-library change. Parking is deliberate, so waking rows is deliberate
 * too: there is no automatic sweep, and mass requeue needs an explicit --all.
 *
 * --dry-run reports what WOULD be requeued and changes nothing.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const environment = arg('environment') as AppleEnvironment | undefined;
  const originalTransactionId = arg('original-transaction-id');
  const all = flag('all');
  const dryRun = flag('dry-run');

  if (environment && environment !== 'Production' && environment !== 'Sandbox') {
    console.error(`--environment must be Production or Sandbox (got ${environment})`);
    process.exit(2);
  }

  const scope = originalTransactionId
    ? `originalTransactionId=${originalTransactionId}`
    : environment ? `environment=${environment}` : 'ALL parked rows';

  const parked = await countParkedAppleReconciliations({ environment, originalTransactionId });
  console.log(`parked rows matching ${scope}: ${parked}`);

  if (dryRun) {
    console.log('--dry-run: nothing was changed');
    return;
  }
  if (parked === 0) {
    console.log('nothing to requeue');
    return;
  }

  try {
    const updated = await requeueParkedAppleReconciliations({ environment, originalTransactionId, all });
    console.log(`requeued ${updated} row(s); they are now pending and due immediately`);
  } catch (err) {
    if (err instanceof RequeueScopeError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
