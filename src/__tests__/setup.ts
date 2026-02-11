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
      delete: vi.fn(),
    },
    userSettings: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    holding: { deleteMany: vi.fn() },
    portfolioSnapshot: { deleteMany: vi.fn() },
    activityEvent: { deleteMany: vi.fn() },
    follow: { deleteMany: vi.fn() },
    alert: { deleteMany: vi.fn() },
    alertEvent: { deleteMany: vi.fn() },
    $transaction: vi.fn((fn: any) => fn(mockPrisma)),
  };

  return {
    default: mockPrisma,
    __mockPrisma: mockPrisma,
  };
});
