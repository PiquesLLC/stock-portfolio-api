import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockPrisma as prismaMock } from '../utils/prisma';

// Must use vi.hoisted() so mock variables exist before vi.mock factory runs
const { sendNotificationMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: sendNotificationMock,
  },
}));

// Mock config with push enabled
vi.mock('../config', () => ({
  config: {
    pushEnabled: true,
    vapidPublicKey: 'test-vapid-public-key',
    vapidPrivateKey: 'test-vapid-private-key',
    vapidSubject: 'mailto:test@nalaai.com',
  },
}));

import { saveSubscription, removeSubscription, sendPushToUser } from '../services/push.service';

describe('push.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveSubscription', () => {
    it('should upsert subscription by endpoint', async () => {
      prismaMock.pushSubscription.upsert.mockResolvedValue({ id: 'sub-1' });

      await saveSubscription('user-1', {
        endpoint: 'https://push.example.com/sub1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      }, 'Mozilla/5.0');

      expect(prismaMock.pushSubscription.upsert).toHaveBeenCalledWith({
        where: { endpoint: 'https://push.example.com/sub1' },
        update: {
          userId: 'user-1',
          p256dh: 'p256dh-key',
          auth: 'auth-key',
          userAgent: 'Mozilla/5.0',
        },
        create: {
          userId: 'user-1',
          endpoint: 'https://push.example.com/sub1',
          p256dh: 'p256dh-key',
          auth: 'auth-key',
          userAgent: 'Mozilla/5.0',
        },
      });
    });

    it('should rebind endpoint to new user on shared device', async () => {
      prismaMock.pushSubscription.upsert.mockResolvedValue({ id: 'sub-1' });

      // User B subscribes on same endpoint as user A
      await saveSubscription('user-B', {
        endpoint: 'https://push.example.com/shared',
        keys: { p256dh: 'key-b', auth: 'auth-b' },
      });

      expect(prismaMock.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint: 'https://push.example.com/shared' },
          update: expect.objectContaining({ userId: 'user-B' }),
        }),
      );
    });
  });

  describe('removeSubscription', () => {
    it('should delete subscription if found for user', async () => {
      prismaMock.pushSubscription.findFirst.mockResolvedValue({ id: 'sub-1', endpoint: 'https://push.example.com/sub1' });
      prismaMock.pushSubscription.delete.mockResolvedValue({});

      const result = await removeSubscription('user-1', 'https://push.example.com/sub1');

      expect(result).toBe(true);
      expect(prismaMock.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    });

    it('should return false if subscription not found', async () => {
      prismaMock.pushSubscription.findFirst.mockResolvedValue(null);

      const result = await removeSubscription('user-1', 'https://push.example.com/nonexistent');

      expect(result).toBe(false);
      expect(prismaMock.pushSubscription.delete).not.toHaveBeenCalled();
    });
  });

  describe('sendPushToUser', () => {
    it('should send push to all user subscriptions', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', endpoint: 'https://push.example.com/1', p256dh: 'key1', auth: 'auth1' },
        { id: 'sub-2', endpoint: 'https://push.example.com/2', p256dh: 'key2', auth: 'auth2' },
      ]);
      sendNotificationMock.mockResolvedValue({});

      await sendPushToUser('user-1', {
        title: 'Test',
        body: 'Test body',
        tag: 'test-tag',
      });

      expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    });

    it('should skip if no subscriptions exist', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([]);

      await sendPushToUser('user-1', { title: 'Test', body: 'body' });

      expect(sendNotificationMock).not.toHaveBeenCalled();
    });

    it('should auto-delete expired subscriptions on 410 Gone', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', endpoint: 'https://push.example.com/expired', p256dh: 'key1', auth: 'auth1' },
      ]);
      sendNotificationMock.mockRejectedValue({ statusCode: 410 });
      prismaMock.pushSubscription.delete.mockResolvedValue({});

      await sendPushToUser('user-1', { title: 'Test', body: 'body' });

      expect(prismaMock.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    });

    it('should auto-delete on 404 Not Found', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', endpoint: 'https://push.example.com/gone', p256dh: 'key1', auth: 'auth1' },
      ]);
      sendNotificationMock.mockRejectedValue({ statusCode: 404 });
      prismaMock.pushSubscription.delete.mockResolvedValue({});

      await sendPushToUser('user-1', { title: 'Test', body: 'body' });

      expect(prismaMock.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
    });

    it('should log but not throw on other errors', async () => {
      prismaMock.pushSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', endpoint: 'https://push.example.com/err', p256dh: 'key1', auth: 'auth1' },
      ]);
      sendNotificationMock.mockRejectedValue({ statusCode: 500 });

      // Should not throw
      await sendPushToUser('user-1', { title: 'Test', body: 'body' });

      // Should NOT delete the subscription on non-410/404
      expect(prismaMock.pushSubscription.delete).not.toHaveBeenCalled();
    });
  });

  describe('PUSH_ENABLED hard-stop', () => {
    it('should skip send when push is disabled', async () => {
      // Temporarily override config
      const { config } = await import('../config');
      const original = config.pushEnabled;
      (config as any).pushEnabled = false;

      await sendPushToUser('user-1', { title: 'Test', body: 'body' });

      expect(prismaMock.pushSubscription.findMany).not.toHaveBeenCalled();
      expect(sendNotificationMock).not.toHaveBeenCalled();

      // Restore
      (config as any).pushEnabled = original;
    });
  });
});
