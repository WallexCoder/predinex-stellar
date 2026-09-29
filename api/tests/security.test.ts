import { describe, it, expect, vi, afterEach } from 'vitest';
import { RateLimiter } from '../src/middleware/rate-limit.js';
import { AuthValidator } from '../src/middleware/auth.js';
import { SecuritySanitizer } from '../src/middleware/security.js';

describe('Security Measures & Middleware Validation', () => {
  it('enforces sliding-window rate limiting', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });
    const client = '192.168.1.100';

    expect(limiter.checkLimit(client).allowed).toBe(true);
    expect(limiter.checkLimit(client).allowed).toBe(true);
    expect(limiter.checkLimit(client).allowed).toBe(true);
    // 4th request blocked
    const blocked = limiter.checkLimit(client);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('verifies HMAC-SHA256 signatures with constant-time equality', () => {
    const auth = new AuthValidator('my-secret-key-123');
    const payload = JSON.stringify({ action: 'verify', user: 'G123' });
    const validSig = auth.signPayload(payload);

    expect(auth.verifySignature(payload, validSig)).toBe(true);
    expect(auth.verifySignature(payload, 'sha256=invalidhex00000000000000000000000000000000000000000000000000000000')).toBe(false);
  });

  it('sanitizes addresses and rejects malformed Stellar public keys', () => {
    expect(SecuritySanitizer.isValidStellarAddress('GAX765YUVH7654321012345678901234567890123456789012345678')).toBe(true);
    expect(SecuritySanitizer.isValidStellarAddress('invalid_address_format')).toBe(false);
    expect(SecuritySanitizer.isValidStellarAddress('0x1234567890abcdef')).toBe(false);
  });

  it('detects and rejects prototype pollution attempts', () => {
    const cleanObj = { key: 'value' };
    expect(SecuritySanitizer.isSafeJson(cleanObj)).toBe(true);

    const polluted = JSON.parse('{"__proto__": {"admin": true}}');
    expect(SecuritySanitizer.isSafeJson(polluted)).toBe(false);
  });
});


describe('Extended Auth & Rate Limit Coverage', () => {
  it('authenticates role-based headers correctly', () => {
    const auth = new AuthValidator('secret-key-123');
    auth.registerKey('adm-1', 'Admin');
    auth.registerKey('off-1', 'ComplianceOfficer');
    auth.registerKey('ass-1', 'Assessor');

    expect(auth.authenticate({})).toEqual({ role: 'User' });
    expect(auth.authenticate({ 'x-api-key': 'adm-1' })).toEqual({ apiKey: 'adm-1', role: 'Admin' });
    expect(auth.authenticate({ 'x-api-key': 'off-1' })).toEqual({ apiKey: 'off-1', role: 'ComplianceOfficer' });
    expect(auth.authenticate({ 'x-api-key': 'ass-1' })).toEqual({ apiKey: 'ass-1', role: 'Assessor' });
    expect(auth.authenticate({ 'x-api-key': 'unknown' })).toEqual({ apiKey: 'unknown', role: 'User' });
  });

  it('handles invalid signature prefixes and length mismatches', () => {
    const auth = new AuthValidator('secret-key-123');
    expect(auth.verifySignature('test', 'badprefix_123')).toBe(false);
    expect(auth.verifySignature('test', 'sha256=tooshort')).toBe(false);
  });

  it('resets rate limit tracker for specific client or globally', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    limiter.checkLimit('client-a');
    limiter.checkLimit('client-a');
    expect(limiter.checkLimit('client-a').allowed).toBe(false);

    limiter.reset('client-a');
    expect(limiter.checkLimit('client-a').allowed).toBe(true);

    limiter.reset();
    expect(limiter.checkLimit('client-a').allowed).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// #1276 — Rate-limiter keyed on attacker-controlled headers
// ---------------------------------------------------------------------------

describe('#1276 — clientIdFor uses validated identity only', () => {
  /**
   * Integration-level tests that exercise createRateLimitMiddleware via a
   * lightweight mock Request so we don't need to stand up a full Express app.
   */
  it('does not create a new bucket for each unique unregistered x-api-key', async () => {
    // Import inline so we get the real sharedAuthValidator instance
    const { createRateLimitMiddleware, RateLimiter } = await import(
      '../src/middleware/rate-limit.js'
    );
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3, sweepIntervalMs: 0 });
    const middleware = createRateLimitMiddleware(limiter);

    // Send 10 requests each with a different unregistered key; they should
    // all share the same socket-IP bucket and eventually be rate-limited.
    let blocked = 0;
    for (let i = 0; i < 10; i++) {
      const req: any = {
        headers: { 'x-api-key': `random-junk-key-${i}` },
        ip: '10.0.0.1',
      };
      let statusCode = 200;
      const res: any = {
        setHeader() {},
        status(code: number) { statusCode = code; return this; },
        json() {},
      };
      const next = vi.fn();
      middleware(req, res, next);
      if (statusCode === 429) blocked++;
    }

    // After maxRequests (3) the bucket should be exhausted and subsequent
    // requests must return 429 — proving they all share one bucket.
    expect(blocked).toBeGreaterThan(0);
    limiter.destroy();
  });

  it('assigns separate buckets to two *different* registered API keys', async () => {
    const { sharedAuthValidator } = await import('../src/middleware/auth.js');
    // Register two distinct keys for this test
    sharedAuthValidator.registerKey('test-key-alpha', 'Admin');
    sharedAuthValidator.registerKey('test-key-beta', 'Admin');

    const { createRateLimitMiddleware, RateLimiter } = await import(
      '../src/middleware/rate-limit.js'
    );
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2, sweepIntervalMs: 0 });
    const middleware = createRateLimitMiddleware(limiter);

    function makeReq(key: string) {
      return { headers: { 'x-api-key': key }, ip: '10.0.0.1' } as any;
    }
    function makeRes() {
      return {
        _status: 200,
        setHeader() {},
        status(code: number) { this._status = code; return this; },
        json() {},
      } as any;
    }

    // Exhaust alpha's bucket
    const next1 = vi.fn();
    middleware(makeReq('test-key-alpha'), makeRes(), next1);
    const next2 = vi.fn();
    middleware(makeReq('test-key-alpha'), makeRes(), next2);
    const res3 = makeRes(); const next3 = vi.fn();
    middleware(makeReq('test-key-alpha'), res3, next3);
    expect(res3._status).toBe(429);

    // Beta should still have its own clean bucket
    const res4 = makeRes(); const next4 = vi.fn();
    middleware(makeReq('test-key-beta'), res4, next4);
    expect(next4).toHaveBeenCalled();
    expect(res4._status).toBe(200);

    limiter.destroy();
  });
});

describe('#1276 — RateLimiter TTL sweep removes expired entries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweep() removes entries whose window has expired', () => {
    const limiter = new RateLimiter({ windowMs: 1_000, maxRequests: 10, sweepIntervalMs: 0 });
    const now = Date.now();

    // Add a request that expires 500 ms ago and one that is still active
    limiter.checkLimit('expired-client', now - 1_500);
    limiter.checkLimit('active-client', now);

    // Run the sweep as of "now"
    limiter.sweep(now);

    // After sweep, expired-client gets a fresh window (its old entry was removed)
    const freshResult = limiter.checkLimit('expired-client', now);
    expect(freshResult.remaining).toBe(9); // full allowance minus this call = 9

    // active-client entry was kept; its count still includes the earlier hit
    const activeResult = limiter.checkLimit('active-client', now);
    expect(activeResult.remaining).toBeLessThan(9);

    limiter.destroy();
  });

  it('periodic sweep runs via setInterval and prunes the map', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ windowMs: 1_000, maxRequests: 5, sweepIntervalMs: 500 });
    const past = Date.now() - 2_000;

    // Manually age an entry so it is already expired
    limiter.checkLimit('old-ip', past);

    // After the interval fires the expired entry should be gone; a new call
    // gets a fresh counter starting at 1 (remaining = 4).
    vi.advanceTimersByTime(600);
    const result = limiter.checkLimit('old-ip');
    expect(result.remaining).toBe(4);

    limiter.destroy();
  });
});
