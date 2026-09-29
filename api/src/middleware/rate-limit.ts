/**
 * Sliding-Window Rate Limiting Middleware.
 * Prevents denial-of-service and brute-force attacks on simulation & transaction endpoints.
 *
 * The `RateLimiter` class below is the counting primitive; the Express
 * wrappers at the bottom of this file apply it to HTTP routes (see #1196).
 * Previously the limiter was exported from the barrel but never mounted.
 *
 * Security fixes (see #1276):
 *  1. clientIdFor now keys on a *validated* identity only — an API key is
 *     only used as the bucket when it exists in the sharedAuthValidator
 *     registry.  Unregistered / arbitrary x-api-key values fall through to
 *     the real socket address so an attacker cannot manufacture unlimited
 *     buckets by sending random header values.
 *  2. X-Forwarded-For is no longer trusted directly.  Express' trust-proxy
 *     setting (configured in app.ts) makes req.ip reliable; we use that
 *     instead.
 *  3. RateLimiter now starts a periodic sweep that evicts expired entries so
 *     the clients map cannot grow without bound for the process lifetime.
 */

import type { NextFunction, Request, Response } from 'express';
import { sharedAuthValidator } from './auth.js';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  /** How often (ms) to run the sweep that removes expired entries.
   *  Defaults to the same value as windowMs.  Set to 0 to disable. */
  sweepIntervalMs?: number;
}

interface ClientTracker {
  count: number;
  resetTime: number;
}

export class RateLimiter {
  private clients = new Map<string, ClientTracker>();
  private windowMs: number;
  private maxRequests: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: Partial<RateLimitOptions>) {
    this.windowMs = options?.windowMs ?? 60_000; // 1 minute
    this.maxRequests = options?.maxRequests ?? 100; // 100 req/min

    const sweepIntervalMs = options?.sweepIntervalMs ?? this.windowMs;
    if (sweepIntervalMs > 0) {
      // unref() so the timer does not prevent the process from exiting cleanly
      const timer = setInterval(() => this.sweep(), sweepIntervalMs);
      if (timer.unref) timer.unref();
      this.sweepTimer = timer;
    }
  }

  /** Remove all entries whose rate-limit window has already expired. */
  public sweep(now: number = Date.now()): void {
    for (const [id, tracker] of this.clients) {
      if (now >= tracker.resetTime) {
        this.clients.delete(id);
      }
    }
  }

  public checkLimit(clientId: string, now: number = Date.now()): {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetMs: number;
  } {
    const existing = this.clients.get(clientId);

    if (!existing || now >= existing.resetTime) {
      const tracker: ClientTracker = {
        count: 1,
        resetTime: now + this.windowMs,
      };
      this.clients.set(clientId, tracker);
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: this.maxRequests - 1,
        resetMs: this.windowMs,
      };
    }

    if (existing.count >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetMs: Math.max(0, existing.resetTime - now),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - existing.count,
      resetMs: Math.max(0, existing.resetTime - now),
    };
  }

  public reset(clientId?: string): void {
    if (clientId) {
      this.clients.delete(clientId);
    } else {
      this.clients.clear();
    }
  }

  /** Stop the background sweep timer (useful in tests / graceful shutdown). */
  public destroy(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

/** Shared limiter for general API traffic (100 req/min per client). */
export const sharedRateLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
});

/** Stricter limiter for state-changing / emergency endpoints (20 req/min). */
export const strictRateLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
});

/**
 * Derive a stable, attacker-resistant client identifier.
 *
 * Priority:
 *  1. A *validated* API key (exists in the sharedAuthValidator registry).
 *     Using an unregistered key is identical to not sending one at all — the
 *     attacker cannot create unlimited buckets by inventing random strings.
 *  2. The socket-level IP address as resolved by Express after trust-proxy
 *     has been applied (set in createApp() in app.ts).  req.ip is used
 *     directly; we never read X-Forwarded-For ourselves.
 */
function clientIdFor(req: Request): string {
  // Only honour x-api-key when it is a key the validator actually knows about.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    if (sharedAuthValidator.isRegistered(apiKey)) {
      return `key:${apiKey}`;
    }
  }

  // Fall back to the real IP address (trust-proxy is configured in app.ts so
  // Express sanitises X-Forwarded-For before exposing it via req.ip).
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Create Express middleware backed by a `RateLimiter`.
 * Sets `RateLimit-*` headers and returns 429 when the window is exhausted.
 */
export function createRateLimitMiddleware(limiter?: RateLimiter) {
  const active = limiter || sharedRateLimiter;
  return (req: Request, res: Response, next: NextFunction): void => {
    const clientId = clientIdFor(req);
    const result = active.checkLimit(clientId);
    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
    if (!result.allowed) {
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please retry later',
          retryAfter: Math.ceil(result.resetMs / 1000),
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    next();
  };
}

/** Default per-route limiter — `app.use(rateLimitMiddleware)` or per-router. */
export const rateLimitMiddleware = createRateLimitMiddleware(sharedRateLimiter);

/** Stricter limiter for emergency / mutating routes. */
export const strictRateLimitMiddleware =
  createRateLimitMiddleware(strictRateLimiter);
