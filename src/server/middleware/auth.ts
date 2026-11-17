import type { Context, Next } from 'hono';
import type { UserProfile } from '../../shared/types.ts';
import type { ResolvedServerConfig, ServerBindings } from '../env.ts';
import { verifySessionToken } from '../lib/crypto.ts';
import { ensureSeededSandboxAccounts, isAdminRole, sanitizeUser, type WorkspaceStore } from '../lib/store.ts';

export interface AuthContextVariables {
  requestId: string;
  serverConfig: ResolvedServerConfig;
  store: WorkspaceStore;
  currentUser: UserProfile;
}

export async function authenticateRequest(
  c: Context<{ Bindings: ServerBindings; Variables: AuthContextVariables }>,
  next: Next,
) {
  const config = c.get('serverConfig');
  const store = c.get('store');
  await ensureSeededSandboxAccounts(store);

  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Please sign in to Avarest One.',
          requestId: c.get('requestId'),
        },
      },
      401,
    );
  }

  // 1. If Supabase is configured, validate token directly with Supabase Auth
  if (config.supabaseConfigured && config.supabaseUrl && config.supabaseAnonKey) {
    try {
      const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: config.supabaseAnonKey,
        },
      });
      if (!res.ok) {
        return c.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired Supabase session.', requestId: c.get('requestId') } },
          401,
        );
      }
      const supaUser = (await res.json()) as { id: string; email?: string; user_metadata?: { full_name?: string } };
      let stored = store.users.get(supaUser.id);
      if (!stored) {
        // Hydrate workspace profile record
        stored = {
          id: supaUser.id,
          email: supaUser.email || 'unknown@avarestai.com',
          fullName: supaUser.user_metadata?.full_name || supaUser.email || 'Avarest User',
          role: 'user',
          language: 'en',
          experienceMode: 'beginner',
          memoryConsent: false,
          activePlan: 'free',
          createdAt: new Date().toISOString(),
          passwordHash: '',
        };
        store.users.set(supaUser.id, stored);
        store.credits.set(supaUser.id, { balance: 100, monthlyAllowance: 100 });
      }
      c.set('currentUser', sanitizeUser(stored));
      await next();
      return;
    } catch {
      return c.json(
        { error: { code: 'AUTH_UPSTREAM_ERROR', message: 'Unable to verify session with Supabase Auth.', requestId: c.get('requestId') } },
        502,
      );
    }
  }

  // 2. Local Staging Sandbox HMAC token verification (strictly disallowed in production)
  if (config.environment === 'production') {
    return c.json(
      {
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Production authentication requires Supabase credentials.',
          requestId: c.get('requestId'),
        },
      },
      503,
    );
  }

  const payload = await verifySessionToken(token, config.authSessionSecret);
  if (!payload) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired session token.', requestId: c.get('requestId') } },
      401,
    );
  }

  const stored = store.users.get(payload.sub);
  if (!stored) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Session user no longer exists.', requestId: c.get('requestId') } },
      401,
    );
  }

  c.set('currentUser', sanitizeUser(stored));
  await next();
}

export async function requireAdmin(
  c: Context<{ Bindings: ServerBindings; Variables: AuthContextVariables }>,
  next: Next,
) {
  const user = c.get('currentUser');
  if (!user || !isAdminRole(user.role)) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Administrator privileges required to access this endpoint.',
          requestId: c.get('requestId'),
        },
      },
      403,
    );
  }
  await next();
}

// Sliding-window in-memory rate limiter (Edge-compatible)
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxRequests: number, windowMs: number) {
  return async (
    c: Context<{ Bindings: ServerBindings; Variables: AuthContextVariables }>,
    next: Next,
  ) => {
    const user = c.get('currentUser');
    const key = `${user?.id || c.req.header('x-forwarded-for') || 'anon'}:${c.req.path}`;
    const now = Date.now();
    const existing = rateLimitBuckets.get(key);

    if (!existing || now > existing.resetAt) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (existing.count >= maxRequests) {
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

    existing.count += 1;
    await next();
  };
}
