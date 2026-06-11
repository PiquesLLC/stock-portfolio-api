import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { config } from '../config';
import { clientIp, isViaCloudflare } from '../middleware/rateLimiter';

// ─────────────────────────────────────────────────────────────────────────────
// H4: the Railway origin is reachable directly, bypassing Cloudflare, so the
// CF-Connecting-IP header is attacker-controllable. The rate limiter trusts it
// ONLY when the request also proves it came through our Cloudflare zone (via a
// secret X-Origin-Auth header). Otherwise it falls back to request.ip (the
// Railway-edge-written XFF client) — which is also the prior behavior, so the
// change is inert until the secret is configured. The Capacitor native app hits
// the origin directly (no CF header) and must keep its per-client request.ip key.
// ─────────────────────────────────────────────────────────────────────────────

function fakeReq(opts: {
  headers?: Record<string, string>;
  ip?: string;
  remoteAddress?: string;
}): Request {
  return {
    headers: opts.headers ?? {},
    ip: opts.ip,
    socket: { remoteAddress: opts.remoteAddress } as any,
  } as unknown as Request;
}

const SECRET = 'cf-origin-shared-secret-1234567890';
const CF_CLIENT = '203.0.113.7';  // "real client" IP as Cloudflare reports it
const XFF_CLIENT = '198.51.100.9'; // request.ip — what Railway's edge writes to XFF

describe('H4: rate-limit client-IP trust', () => {
  const original = config.cloudflareOriginSecret;
  afterEach(() => {
    (config as any).cloudflareOriginSecret = original;
  });

  describe('secret NOT configured (legacy / inert default)', () => {
    beforeEach(() => {
      (config as any).cloudflareOriginSecret = '';
    });

    it('treats every request as via-Cloudflare and trusts CF-Connecting-IP', () => {
      expect(isViaCloudflare(fakeReq({}))).toBe(true);
      const req = fakeReq({ headers: { 'cf-connecting-ip': CF_CLIENT }, ip: XFF_CLIENT });
      expect(clientIp(req)).toBe(CF_CLIENT);
    });

    it('native-style request (no CF header) keys on request.ip — identical to legacy', () => {
      // The inertness guarantee: with no secret set, a direct/native request with
      // no CF-Connecting-IP must resolve to request.ip exactly as before.
      const req = fakeReq({ headers: {}, ip: XFF_CLIENT, remoteAddress: '10.0.0.5' });
      expect(clientIp(req)).toBe(XFF_CLIENT);
    });
  });

  describe('secret configured', () => {
    beforeEach(() => {
      (config as any).cloudflareOriginSecret = SECRET;
    });

    it('trusts CF-Connecting-IP when X-Origin-Auth matches', () => {
      const req = fakeReq({
        headers: { 'x-origin-auth': SECRET, 'cf-connecting-ip': CF_CLIENT },
        ip: XFF_CLIENT,
      });
      expect(isViaCloudflare(req)).toBe(true);
      expect(clientIp(req)).toBe(CF_CLIENT);
    });

    it('IGNORES a forged CF-Connecting-IP on a direct origin hit (no secret header)', () => {
      // Core H4 property: a direct-to-origin attacker rotating CF-Connecting-IP
      // can no longer reset per-IP limits — keying uses request.ip, which they
      // cannot forge (Railway's edge writes it), not the spoofed header.
      const req = fakeReq({
        headers: { 'cf-connecting-ip': '6.6.6.6' },
        ip: XFF_CLIENT,
      });
      expect(isViaCloudflare(req)).toBe(false);
      expect(clientIp(req)).toBe(XFF_CLIENT);
    });

    it('keys native traffic (no CF header) on its own request.ip — not collapsed', () => {
      const native = fakeReq({ headers: {}, ip: XFF_CLIENT });
      expect(isViaCloudflare(native)).toBe(false);
      expect(clientIp(native)).toBe(XFF_CLIENT);
    });

    it('rejects a wrong secret value', () => {
      expect(isViaCloudflare(fakeReq({ headers: { 'x-origin-auth': 'totally-wrong' } }))).toBe(false);
    });

    it('rejects a wrong-length secret without throwing (timingSafeEqual guard)', () => {
      expect(isViaCloudflare(fakeReq({ headers: { 'x-origin-auth': SECRET + 'EXTRA' } }))).toBe(false);
      expect(isViaCloudflare(fakeReq({ headers: { 'x-origin-auth': '' } }))).toBe(false);
    });

    it('falls back to request.ip when the secret is valid but CF header is absent', () => {
      const req = fakeReq({ headers: { 'x-origin-auth': SECRET }, ip: XFF_CLIENT });
      expect(clientIp(req)).toBe(XFF_CLIENT);
    });
  });
});
