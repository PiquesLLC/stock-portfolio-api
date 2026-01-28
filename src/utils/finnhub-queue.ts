/**
 * Centralized Finnhub Request Queue
 *
 * Features:
 * - Single-threaded request processing (concurrency = 1)
 * - Minimum delay between requests (1200ms for free tier)
 * - Exponential backoff on 429/403 errors
 * - Retry up to 3 times with backoff
 * - Rate limit state tracking
 */

import axios, { AxiosError } from 'axios';
import { config } from '../config';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
const MIN_REQUEST_DELAY_MS = 1200; // 1.2s between requests (50/min safe margin)
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

interface QueuedRequest<T> {
  endpoint: string;
  params: Record<string, unknown>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
}

class FinnhubRequestQueue {
  private queue: QueuedRequest<unknown>[] = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private rateLimitedUntil = 0;
  private consecutiveErrors = 0;

  /**
   * Add a request to the queue
   */
  async request<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        endpoint,
        params,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries: 0,
      });

      this.processQueue();
    });
  }

  /**
   * Check if we're currently rate limited
   */
  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /**
   * Get time until rate limit expires (ms)
   */
  getRateLimitRemainingMs(): number {
    return Math.max(0, this.rateLimitedUntil - Date.now());
  }

  /**
   * Process the queue one request at a time
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const request = this.queue[0];

      // Check rate limit
      if (this.isRateLimited()) {
        const waitTime = this.getRateLimitRemainingMs();
        console.log(`[FinnhubQueue] Rate limited, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
      }

      // Ensure minimum delay between requests
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < MIN_REQUEST_DELAY_MS) {
        const delay = MIN_REQUEST_DELAY_MS - timeSinceLastRequest;
        await this.sleep(delay);
      }

      try {
        const result = await this.executeRequest(request);
        this.consecutiveErrors = 0;
        request.resolve(result);
        this.queue.shift();
      } catch (error) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;

        // Handle rate limiting (429)
        if (status === 429) {
          this.consecutiveErrors++;
          const backoff = this.calculateBackoff(request.retries);

          console.warn(`[FinnhubQueue] Rate limited (429), backoff ${backoff}ms, attempt ${request.retries + 1}/${MAX_RETRIES}`);

          // Set rate limit timeout
          this.rateLimitedUntil = Date.now() + backoff;

          if (request.retries < MAX_RETRIES) {
            request.retries++;
            // Don't remove from queue, retry after backoff
            await this.sleep(backoff);
          } else {
            // Max retries exceeded, reject and move on
            request.reject(new Error(`Rate limited after ${MAX_RETRIES} retries`));
            this.queue.shift();
          }
        } else if (status === 403) {
          // 403 typically means plan limitation (not rate limit)
          // Don't retry - just reject immediately
          console.warn(`[FinnhubQueue] Access denied (403) for ${request.endpoint} - may require paid plan`);
          request.reject(new Error('ACCESS_DENIED: This endpoint may require a Finnhub paid plan'));
          this.queue.shift();
        } else {
          // Other errors - reject immediately
          request.reject(error instanceof Error ? error : new Error(String(error)));
          this.queue.shift();
        }
      }

      this.lastRequestTime = Date.now();
    }

    this.isProcessing = false;
  }

  /**
   * Execute a single request
   */
  private async executeRequest<T>(request: QueuedRequest<T>): Promise<T> {
    const response = await axios.get<T>(`${FINNHUB_BASE_URL}${request.endpoint}`, {
      params: {
        ...request.params,
        token: config.finnhubApiKey,
      },
      timeout: 10000,
    });

    return response.data;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoff(retries: number): number {
    // Exponential backoff: 2s, 4s, 8s, 16s...
    const baseBackoff = INITIAL_BACKOFF_MS * Math.pow(2, retries);
    // Add jitter (0-500ms) to prevent thundering herd
    const jitter = Math.random() * 500;
    return Math.min(baseBackoff + jitter, 60000); // Cap at 60s
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue stats for debugging
   */
  getStats(): { queueLength: number; isProcessing: boolean; rateLimitedUntil: number; consecutiveErrors: number } {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      rateLimitedUntil: this.rateLimitedUntil,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  /**
   * Clear the queue (cancel pending requests)
   */
  clear(): void {
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      request?.reject(new Error('Queue cleared'));
    }
  }
}

// Singleton instance
export const finnhubQueue = new FinnhubRequestQueue();
