import type { Context, Next } from 'hono';
import { isValidKVNamespaceBinding, type KVNamespaceLike, type ResolvedServerConfig, type ServerBindings } from '../env.ts';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtEpochSec: number;
}

export interface RateLimitAdapter {
  readonly mode: 'distributed_kv' | 'single_instance_memory';
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Distributed Cloudflare KV adapter (or compatible distributed KV store).
 * Note: KV is eventually consistent across edge PoPs; for strict single-digit
 * atomic synchronization under burst load, swap this adapter with a Durable Object.
 */
export class KVRateLimitAdapter implements RateLimitAdapter {
  readonly mode = 'distributed_kv' as const;
  private readonly kv: KVNamespaceLike;

  constructor(kv: KVNamespaceLike) {
    this.kv = kv;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucketId = Math.floor(now / windowMs);
    const kvKey = `rl:${key}:${bucketId}`;
    const resetAtEpochSec = Math.ceil(((bucketId + 1) * windowMs) / 1000);
    const ttlSeconds = Math.max(60, Math.ceil(windowMs / 1000) + 5);

    const raw = await this.kv.get(kvKey);
    const current = raw ? Number.parseInt(raw, 10) || 0 : 0;

    if (current >= limit) {
      return { allowed: false, limit, remaining: 0, resetAtEpochSec };
    }

    const next = current + 1;
    await this.kv.put(kvKey, String(next), { expirationTtl: ttlSeconds });
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - next),
      resetAtEpochSec,
    };
  }
}

/**
 * Single-instance in-memory sliding/fixed-window fallback for local dev/testing.
 * Not shared across distributed worker isolates or horizontal Node replicas.
 */
export class MemoryRateLimitAdapter implements RateLimitAdapter {
  readonly mode = 'single_instance_memory' as const;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || now > existing.resetAt) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        limit,
        remaining: Math.max(0, limit - 1),
        resetAtEpochSec: Math.ceil(resetAt / 1000),
      };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAtEpochSec: Math.ceil(existing.resetAt / 1000),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - existing.count),
      resetAtEpochSec: Math.ceil(existing.resetAt / 1000),
    };
  }
}

const defaultMemoryRateLimiter = new MemoryRateLimitAdapter();

export function resolveRateLimitAdapter(bindings?: ServerBindings): RateLimitAdapter {
  if (isValidKVNamespaceBinding(bindings?.RATE_LIMIT_KV)) {
    return new KVRateLimitAdapter(bindings.RATE_LIMIT_KV);
  }
  return defaultMemoryRateLimiter;
}

export function rateLimit(maxRequests: number, windowMs: number) {
  return async (
    c: Context<{
      Bindings: ServerBindings;
      Variables: {
        requestId: string;
        serverConfig: ResolvedServerConfig;
        rateLimiter: RateLimitAdapter;
        currentUser?: { id: string };
      };
    }>,
    next: Next,
  ) => {
    const user = c.get('currentUser');
    const adapter = c.get('rateLimiter') || defaultMemoryRateLimiter;
    const clientIp =
      c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
    const key = `${user?.id || clientIp}:${c.req.path}`;
    const result = await adapter.consume(key, maxRequests, windowMs);

    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAtEpochSec));

    if (!result.allowed) {
      c.header('Retry-After', String(Math.max(1, result.resetAtEpochSec - Math.floor(Date.now() / 1000))));
      return c.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please wait briefly before retrying.',
            requestId: c.get('requestId'),
          },
        },
        429,
      );
    }

    await next();
  };
}
