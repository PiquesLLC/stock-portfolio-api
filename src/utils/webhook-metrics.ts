import * as Sentry from '@sentry/node';

type WebhookSource = 'billing' | 'creator';
type WebhookOutcome = 'processed' | 'failed' | 'deduped';

interface WebhookEvent {
  source: WebhookSource;
  outcome: WebhookOutcome;
  eventType: string;
  timestamp: number;
}

// Sliding window — keep last 60 minutes of events
const WINDOW_MS = 60 * 60 * 1000;
const events: WebhookEvent[] = [];

// Threshold config (matches alerting-policy.md)
const FAILURE_RATE_THRESHOLD = 0.05; // 5%
const FAILURE_COUNT_MIN = 5;
const DEDUP_RATE_THRESHOLD = 0.20; // 20%
const EVAL_WINDOW_MS = 5 * 60 * 1000; // 5-minute evaluation window

let lastAlertAt = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // Don't spam: max 1 alert per 15 min

function pruneOldEvents(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (events.length > 0 && events[0].timestamp < cutoff) {
    events.shift();
  }
}

export function recordWebhookEvent(source: WebhookSource, outcome: WebhookOutcome, eventType: string): void {
  events.push({ source, outcome, eventType, timestamp: Date.now() });
  pruneOldEvents();
}

export function getWebhookMetrics() {
  pruneOldEvents();
  const now = Date.now();
  const recentCutoff = now - EVAL_WINDOW_MS;

  const metrics: Record<WebhookSource, {
    total_1h: number;
    processed_1h: number;
    failed_1h: number;
    deduped_1h: number;
    total_5m: number;
    failed_5m: number;
    deduped_5m: number;
    failureRate5m: number;
    dedupRate5m: number;
  }> = {
    billing: { total_1h: 0, processed_1h: 0, failed_1h: 0, deduped_1h: 0, total_5m: 0, failed_5m: 0, deduped_5m: 0, failureRate5m: 0, dedupRate5m: 0 },
    creator: { total_1h: 0, processed_1h: 0, failed_1h: 0, deduped_1h: 0, total_5m: 0, failed_5m: 0, deduped_5m: 0, failureRate5m: 0, dedupRate5m: 0 },
  };

  for (const e of events) {
    const m = metrics[e.source];
    m.total_1h++;
    if (e.outcome === 'processed') m.processed_1h++;
    else if (e.outcome === 'failed') m.failed_1h++;
    else if (e.outcome === 'deduped') m.deduped_1h++;

    if (e.timestamp >= recentCutoff) {
      m.total_5m++;
      if (e.outcome === 'failed') m.failed_5m++;
      else if (e.outcome === 'deduped') m.deduped_5m++;
    }
  }

  for (const source of ['billing', 'creator'] as const) {
    const m = metrics[source];
    m.failureRate5m = m.total_5m > 0 ? m.failed_5m / m.total_5m : 0;
    m.dedupRate5m = m.total_5m > 0 ? m.deduped_5m / m.total_5m : 0;
  }

  return {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    billing: metrics.billing,
    creator: metrics.creator,
  };
}

export function evaluateWebhookThresholds(): void {
  const m = getWebhookMetrics();
  const now = Date.now();
  const alerts: string[] = [];

  for (const source of ['billing', 'creator'] as const) {
    const s = m[source];

    // P1: Failure rate spike
    if (s.failureRate5m > FAILURE_RATE_THRESHOLD && s.failed_5m >= FAILURE_COUNT_MIN) {
      alerts.push(`[P1] ${source} webhook failure rate ${(s.failureRate5m * 100).toFixed(1)}% (${s.failed_5m}/${s.total_5m} in 5m)`);
    }

    // P2: Dedup storm (Stripe retrying excessively)
    if (s.dedupRate5m > DEDUP_RATE_THRESHOLD && s.total_5m >= 10) {
      alerts.push(`[P2] ${source} webhook dedup rate ${(s.dedupRate5m * 100).toFixed(1)}% (${s.deduped_5m}/${s.total_5m} in 5m)`);
    }
  }

  if (alerts.length > 0 && now - lastAlertAt > ALERT_COOLDOWN_MS) {
    lastAlertAt = now;
    const message = `Webhook alert thresholds breached:\n${alerts.join('\n')}`;
    console.error(`[WebhookMetrics] ${message}`);
    Sentry.captureMessage(message, { level: 'error', tags: { component: 'webhook_metrics' } });
  }
}
