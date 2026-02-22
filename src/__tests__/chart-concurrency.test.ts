import { describe, it, expect } from 'vitest';
import { limitConcurrency } from '../services/snapshot.service';

describe('limitConcurrency', () => {
  it('returns results in correct order', async () => {
    const tasks = [1, 2, 3, 4, 5].map(n => async () => n * 10);
    const results = await limitConcurrency(tasks, 3);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds concurrency limit', async () => {
    const concurrent = { now: 0, max: 0 };

    const tasks = Array.from({ length: 60 }, (_, i) => async () => {
      concurrent.now++;
      concurrent.max = Math.max(concurrent.max, concurrent.now);
      // Simulate async work
      await new Promise(r => setTimeout(r, 5));
      concurrent.now--;
      return i;
    });

    const results = await limitConcurrency(tasks, 10);

    expect(concurrent.max).toBeLessThanOrEqual(10);
    expect(results).toHaveLength(60);
    expect(results[0]).toBe(0);
    expect(results[59]).toBe(59);
  });

  it('works with concurrency=1 (sequential)', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map(n => async () => {
      order.push(n);
      await new Promise(r => setTimeout(r, 1));
      return n;
    });

    const results = await limitConcurrency(tasks, 1);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('handles empty task array', async () => {
    const results = await limitConcurrency([], 10);
    expect(results).toEqual([]);
  });

  it('handles concurrency larger than task count', async () => {
    const tasks = [1, 2, 3].map(n => async () => n);
    const results = await limitConcurrency(tasks, 100);
    expect(results).toEqual([1, 2, 3]);
  });

  it('propagates errors from individual tasks', async () => {
    const tasks = [
      async () => 1,
      async () => { throw new Error('task failed'); },
      async () => 3,
    ];

    await expect(limitConcurrency(tasks, 2)).rejects.toThrow('task failed');
  });
});
