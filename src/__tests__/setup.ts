import { vi } from 'vitest';

// The supertest suites lazy-load the full Express app inside their first
// test (`await import('../app')`) so that module-scope env mutations and
// vi.mock factories apply before the route tree is built. That first import
// executes the entire app module graph (hundreds of modules plus heavy deps:
// stripe, sharp, tesseract.js, aws-sdk, plaid, ...) — a one-time per-file
// cost of ~1-3s in isolation, but >5s when every vitest fork cold-imports
// the same graph concurrently during a full run. With vitest's default 5s
// testTimeout, whichever app-suite files lose the CPU/IO scheduling race
// fail their FIRST test with "Test timed out in 5000ms" — the shifting-set
// flakiness seen only in full parallel runs. Give tests/hooks enough budget
// to absorb that contention; genuine hangs still fail, just at 30s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Set test env vars before any imports
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'file:./test.db';
process.env.AI_PREMIUM_ENABLED = 'true';
// Hermetic tests: never let an inherited shell key route the screenshot
// import through the live Claude API (vision path activates on key presence)
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_VISION_MODEL;

// Mock Prisma singleton globally
vi.mock('../utils/prisma', () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    userSettings: {
      create: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshRotationCache: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    portfolio: { findFirst: vi.fn().mockResolvedValue({ id: 'default-portfolio-id', name: 'Default', isDefault: true, userId: 'test-user-1' }), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    holding: { create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), delete: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    portfolioTrade: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    ledgerEvent: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    holdingSnapshot: { deleteMany: vi.fn() },
    portfolioSnapshot: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    portfolioCompositionChange: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    activityEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
    follow: { deleteMany: vi.fn() },
    alert: { deleteMany: vi.fn() },
    alertEvent: { deleteMany: vi.fn() },
    billingWebhookEvent: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // MFA
    mfaMethod: { count: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    mfaChallenge: { deleteMany: vi.fn() },
    mfaBackupCode: { deleteMany: vi.fn(), create: vi.fn() },
    // Consent & email OTP
    consentRecord: { create: vi.fn(), deleteMany: vi.fn() },
    emailOtpCode: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    // Plaid
    plaidItem: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    plaidAccount: { deleteMany: vi.fn() },
    // Alerts (price)
    priceAlert: { deleteMany: vi.fn() },
    priceAlertEvent: { deleteMany: vi.fn() },
    // Watchlists
    watchlist: { deleteMany: vi.fn() },
    // Dividends & lots
    dividendReinvestment: { deleteMany: vi.fn() },
    dividendCredit: { deleteMany: vi.fn() },
    lot: { deleteMany: vi.fn() },
    transaction: { create: vi.fn().mockResolvedValue({}), deleteMany: vi.fn() },
    // Insights & notifications
    milestoneEvent: { deleteMany: vi.fn() },
    anomalyEvent: { deleteMany: vi.fn() },
    notificationAuditLog: { create: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    // AI spend breaker reads these; default to an empty window so AI-path tests
    // are never blocked unless they opt in.
    apiUsageLog: {
      create: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsdEstimate: 0 }, _count: { _all: 0 } }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    deepResearchJob: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { costUsdEstimate: 0 } }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    pushSubscription: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    devicePushToken: { deleteMany: vi.fn() },
    creator: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    creatorVisibility: { findUnique: vi.fn(), update: vi.fn() },
    leaderboardCache: { deleteMany: vi.fn() },
    contentStrike: { create: vi.fn(), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    waitlist: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn((arg: any) => {
      // Support both Prisma transaction styles:
      // 1) prisma.$transaction(async tx => ...)
      // 2) prisma.$transaction([op1, op2, ...])
      if (typeof arg === 'function') return arg(mockPrisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      throw new Error('Unsupported prisma.$transaction mock argument');
    }),
  };

  return {
    default: mockPrisma,
    __mockPrisma: mockPrisma,
  };
});
