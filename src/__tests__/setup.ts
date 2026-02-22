import { vi } from 'vitest';

// Set test env vars before any imports
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL = 'file:./test.db';

// Mock Prisma singleton globally
vi.mock('../utils/prisma', () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    userSettings: {
      create: vi.fn(),
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
    holding: { deleteMany: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    portfolioTrade: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    ledgerEvent: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    holdingSnapshot: { deleteMany: vi.fn() },
    portfolioSnapshot: { deleteMany: vi.fn() },
    portfolioCompositionChange: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    activityEvent: { deleteMany: vi.fn() },
    follow: { deleteMany: vi.fn() },
    alert: { deleteMany: vi.fn() },
    alertEvent: { deleteMany: vi.fn() },
    billingWebhookEvent: {
      create: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // MFA
    mfaMethod: { count: vi.fn(), deleteMany: vi.fn() },
    mfaChallenge: { deleteMany: vi.fn() },
    mfaBackupCode: { deleteMany: vi.fn() },
    // Consent & email OTP
    consentRecord: { create: vi.fn(), deleteMany: vi.fn() },
    emailOtpCode: { create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    // Plaid
    plaidItem: { findMany: vi.fn(), deleteMany: vi.fn() },
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
    transaction: { deleteMany: vi.fn() },
    // Insights & notifications
    milestoneEvent: { deleteMany: vi.fn() },
    anomalyEvent: { deleteMany: vi.fn() },
    notificationAuditLog: { create: vi.fn(), deleteMany: vi.fn() },
    leaderboardCache: { deleteMany: vi.fn() },
    $transaction: vi.fn((fn: any) => fn(mockPrisma)),
  };

  return {
    default: mockPrisma,
    __mockPrisma: mockPrisma,
  };
});
