import type { Context, Next } from 'hono';
import type { UserProfile } from '../../shared/types.ts';
import type { ResolvedServerConfig, ServerBindings } from '../env.ts';
import { verifySessionToken } from '../lib/crypto.ts';
import type { WorkspaceRepository } from '../lib/repository.ts';
import { isAdminRole, sanitizeUser } from '../lib/store.ts';
import type { RateLimitAdapter } from './rateLimit.ts';

export interface AuthContextVariables {
  requestId: string;
  serverConfig: ResolvedServerConfig;
  repo: WorkspaceRepository | null;
  rateLimiter: RateLimitAdapter;
  currentUser: UserProfile;
}

export async function authenticateRequest(
  c: Context<{ Bindings: ServerBindings; Variables: AuthContextVariables }>,
  next: Next,
) {
  if (c.get('currentUser')) {
    await next();
    return;
  }

  const config = c.get('serverConfig');
  const repo = c.get('repo');

  if (config.environment === 'production' && !config.configValidation.authSessionSecretStrong) {
    return c.json(
      {
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Production runtime requires a strong configured AUTH_SESSION_SECRET (>= 16 chars).',
          requestId: c.get('requestId'),
        },
      },
      503,
    );
  }

  if (!repo) {
    return c.json(
      {
        error: {
          code: 'DATABASE_NOT_CONFIGURED',
          message: 'Production runtime requires configured Supabase database credentials.',
          requestId: c.get('requestId'),
        },
      },
      503,
    );
  }

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

  // 1. If Supabase is configured, verify JWT directly with Supabase Auth & load persistent profile
  if (config.supabaseConfigured && config.supabaseUrl && (config.supabaseServiceRoleKey || config.supabaseAnonKey)) {
    // Reject malformed or non-ByteString tokens with 401 before invoking fetch()
    const isAsciiSafe = /^[\x21-\x7E]+$/.test(token);
    const looksLikeJwt = token.split('.').length === 3;
    if (!isAsciiSafe || !looksLikeJwt) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid or malformed Supabase session token.', requestId: c.get('requestId') } },
        401,
      );
    }

    const baseUrl = config.supabaseUrl.replace(/\/+$/, '');
    const apiKeyHeader = (config.supabaseServiceRoleKey || config.supabaseAnonKey!).trim();
    let supaUser: { id?: string; email?: string; user_metadata?: { full_name?: string } } | null = null;

    try {
      const fetchInit: RequestInit = {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: apiKeyHeader,
        },
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        fetchInit.signal = AbortSignal.timeout(10_000);
      }

      const res = await fetch(`${baseUrl}/auth/v1/user`, fetchInit);
      if (!res.ok) {
        if (res.status >= 500) {
          return c.json(
            {
              error: {
                code: 'AUTH_UPSTREAM_ERROR',
                message: 'Supabase Auth service is temporarily unavailable.',
                requestId: c.get('requestId'),
              },
            },
            502,
          );
        }
        return c.json(
          { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired Supabase session.', requestId: c.get('requestId') } },
          401,
        );
      }
      supaUser = (await res.json()) as { id?: string; email?: string; user_metadata?: { full_name?: string } };
    } catch {
      return c.json(
        { error: { code: 'AUTH_UPSTREAM_ERROR', message: 'Unable to verify session with Supabase Auth.', requestId: c.get('requestId') } },
        502,
      );
    }

    if (!supaUser || typeof supaUser.id !== 'string' || !supaUser.id) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired Supabase session.', requestId: c.get('requestId') } },
        401,
      );
    }

    let profile: UserProfile;
    try {
      profile = await repo.upsertProfileFromSupabaseAuth({
        id: supaUser.id,
        email: supaUser.email || 'unknown@avarestai.com',
        fullName: supaUser.user_metadata?.full_name || supaUser.email || 'Avarest User',
      });
    } catch {
      return c.json(
        { error: { code: 'PROFILE_SYNC_ERROR', message: 'Unable to load or provision workspace profile.', requestId: c.get('requestId') } },
        503,
      );
    }

    c.set('currentUser', profile);
    await next();
    return;
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

  const stored = await repo.getUserById(payload.sub);
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
