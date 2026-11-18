import { Hono } from 'hono';
import { z } from 'zod';
import { SUPABASE_PROJECTS, validateEnvironmentIsolation } from '../shared/env.ts';
import type {
  AgentApproval,
  AgentConfig,
  AgentRun,
  ChatMessage,
  ConnectedAccount,
  Conversation,
  ResearchReport,
} from '../shared/types.ts';
import {
  executeProviderCompletion,
  probeProviderConnectivity,
  ProviderExecutionError,
  streamProviderCompletion,
} from './brain/providers.ts';
import { ACTIVE_PROVIDER_IDS, getModelRegistry, getProviderSummary } from './brain/registry.ts';
import { BrainRoutingError, routeWithAvarestBrain } from './brain/router.ts';
import { getServerConfig, type ServerBindings } from './env.ts';
import {
  calculateActualCreditCost,
  DEFAULT_RESERVATION_TTL_SECONDS,
  estimateReservationCredits,
  normalizeIdempotencyKey,
} from './lib/credits.ts';
import { hashPassword, signSessionToken, timingSafeEqualStrings, verifyPassword } from './lib/crypto.ts';
import { MemoryWorkspaceRepository, type WorkspaceRepository } from './lib/repository.ts';
import { chunkTextDocument, defaultStore, sanitizeUser, type WorkspaceStore } from './lib/store.ts';
import { SupabaseWorkspaceRepository } from './lib/supabaseRepo.ts';
import { authenticateRequest, requireAdmin, type AuthContextVariables } from './middleware/auth.ts';
import { rateLimit, resolveRateLimitAdapter } from './middleware/rateLimit.ts';

const ALLOWED_DOC_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

function resolveAllowedOrigin(origin: string | undefined, appUrl: string): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (origin === appUrl) return origin;
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return origin;
    if (parsed.hostname === 'avarestai.com' || parsed.hostname.endsWith('.avarestai.com')) return origin;
    if (parsed.hostname === 'avarest-ai-staging.avarestglobal.workers.dev') return origin;
    if (parsed.hostname.endsWith('.run.app')) return origin;
    return null;
  } catch {
    return null;
  }
}

export function createAvarestApiApp(options?: {
  store?: WorkspaceStore;
  repoOverride?: WorkspaceRepository;
  bindingsOverride?: ServerBindings;
}) {
  const localStore = options?.store || defaultStore;
  const memoryRepo = new MemoryWorkspaceRepository(localStore);
  const app = new Hono<{ Bindings: ServerBindings; Variables: AuthContextVariables }>();

  // Global request ID, security headers, strict CORS allowlist, config resolution, and isolation enforcement
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const path = c.req.path;
    if (path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/admin/')) {
      c.header('Cache-Control', 'no-store');
    }

    const mergedBindings: ServerBindings = {
      ...(c.env || {}),
      ...(options?.bindingsOverride || {}),
    };
    const serverConfig = getServerConfig(mergedBindings);
    c.set('serverConfig', serverConfig);
    c.set('rateLimiter', resolveRateLimitAdapter(mergedBindings));

    const reqOrigin = c.req.header('Origin');
    const allowedOrigin = resolveAllowedOrigin(reqOrigin, serverConfig.appUrl);
    if (allowedOrigin) {
      c.header('Access-Control-Allow-Origin', allowedOrigin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Bootstrap-Secret, Idempotency-Key');
    }
    if (c.req.method === 'OPTIONS') {
      return c.body(null, allowedOrigin ? 204 : 403);
    }

    if (serverConfig.isolationErrors.length > 0) {
      return c.json(
        {
          error: {
            code: 'ENVIRONMENT_ISOLATION_ERROR',
            message: serverConfig.isolationErrors.join(' '),
            requestId,
          },
        },
        500,
      );
    }

    let repo: WorkspaceRepository | null = null;
    if (options?.repoOverride) {
      repo = options.repoOverride;
    } else if (serverConfig.supabaseConfigured && serverConfig.supabaseUrl && serverConfig.supabaseServiceRoleKey) {
      repo = new SupabaseWorkspaceRepository(serverConfig.supabaseUrl, serverConfig.supabaseServiceRoleKey);
    } else if (serverConfig.environment !== 'production') {
      repo = memoryRepo;
    } else {
      // Production strictly refuses silent in-memory fallback
      repo = null;
    }
    c.set('repo', repo);

    await next();
  });

  // Global safe error handler (never expose raw upstream secrets or stack traces)
  app.onError((err, c) => {
    const requestId = c.get('requestId') || crypto.randomUUID();
    if (err instanceof BrainRoutingError) {
      return c.json({ error: { code: err.code, message: err.message, requestId } }, err.statusCode as 400 | 503);
    }
    if (err instanceof ProviderExecutionError) {
      return c.json(
        { error: { code: 'PROVIDER_ERROR', provider: err.providerId, message: err.message, requestId } },
        (err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502) as 400 | 403 | 429 | 502 | 503,
      );
    }
    if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
      return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
    }
    console.error(`[Avarest API Error] ${requestId}:`, err instanceof Error ? err.message : 'Unknown error');
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', requestId } },
      500,
    );
  });

  // =========================================================================
  // PUBLIC HEALTH & SYSTEM STATUS (Honest DB Reachability Check)
  // =========================================================================
  app.get('/api/v1/health', async (c) => {
    const config = c.get('serverConfig');
    const repo = c.get('repo');
    const rateLimiter = c.get('rateLimiter');
    const validation = validateEnvironmentIsolation({
      environment: config.environment,
      supabaseUrl: config.supabaseUrl,
      supabaseKeyPresent: Boolean(config.supabaseServiceRoleKey || config.supabaseAnonKey),
    });

    const dbPing = repo
      ? await repo.pingDatabase()
      : { reachable: false, latencyMs: 0, error: 'Database credentials missing in production environment.' };

    const storageMode =
      repo?.kind === 'supabase'
        ? 'supabase_postgres'
        : repo?.kind === 'memory'
          ? 'local_memory_sandbox'
          : 'unconfigured_blocked';

    const authMode = config.supabaseConfigured
      ? 'supabase'
      : config.environment === 'production'
        ? 'unconfigured_blocked'
        : 'local_sandbox';

    const healthy =
      validation.valid &&
      (config.supabaseConfigured ? dbPing.reachable : config.environment !== 'production') &&
      (config.environment === 'production' ? config.configValidation.authSessionSecretStrong : true);

    return c.json({
      status: healthy ? 'ok' : 'degraded',
      environment: config.environment,
      storageMode,
      rateLimitMode: rateLimiter.mode,
      supabase: {
        expectedUrl: SUPABASE_PROJECTS[config.environment].url,
        configured: config.supabaseConfigured,
        dbReachable: dbPing.reachable,
        dbLatencyMs: dbPing.latencyMs,
        ...(dbPing.error ? { dbError: dbPing.error } : {}),
        isolated: validation.valid,
        authMode,
        errors: validation.errors,
      },
      providers: getProviderSummary(config),
      configValidation: config.configValidation,
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================================
  // AUTHENTICATION (Supabase Auth + Local Staging Sandbox Only)
  // =========================================================================
  const registerSchema = z.object({
    email: z.string().email().max(200),
    password: z.string().min(8).max(128),
    fullName: z.string().min(1).max(100),
  });

  app.post('/api/v1/auth/register', rateLimit(20, 60_000), async (c) => {
    const config = c.get('serverConfig');
    const repo = c.get('repo');
    if (config.supabaseConfigured) {
      return c.json(
        {
          error: {
            code: 'USE_SUPABASE_CLIENT_AUTH',
            message: 'Supabase Auth is active. Register directly via Supabase Auth.',
            requestId: c.get('requestId'),
          },
        },
        400,
      );
    }
    if (config.environment === 'production' || !repo) {
      return c.json(
        { error: { code: 'AUTH_NOT_CONFIGURED', message: 'Production requires Supabase Auth.', requestId: c.get('requestId') } },
        503,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid input', requestId: c.get('requestId') } },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    if (await repo.getUserByEmail(email)) {
      return c.json(
        { error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.', requestId: c.get('requestId') } },
        409,
      );
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(parsed.data.password);
    const profile = await repo.createLocalUser(
      {
        id,
        email,
        fullName: parsed.data.fullName.trim(),
        role: 'user', // Never trust client-supplied role
        language: 'en',
        experienceMode: 'beginner',
        memoryConsent: false,
        activePlan: 'free',
        createdAt: new Date().toISOString(),
        passwordHash,
      },
      100,
    );

    await repo.appendAuditLog({
      actorId: id,
      action: 'auth.register',
      resourceType: 'profile',
      resourceId: id,
      detail: `Registered workspace user ${email}`,
    });

    const token = await signSessionToken(
      { sub: id, email, role: 'user', exp: Date.now() + 24 * 60 * 60 * 1000 },
      config.authSessionSecret,
    );

    return c.json({ token, user: profile }, 201);
  });

  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  app.post('/api/v1/auth/login', rateLimit(30, 60_000), async (c) => {
    const config = c.get('serverConfig');
    const repo = c.get('repo');
    if (config.supabaseConfigured) {
      return c.json(
        {
          error: {
            code: 'USE_SUPABASE_CLIENT_AUTH',
            message: 'Supabase Auth is active. Sign in via Supabase Auth.',
            requestId: c.get('requestId'),
          },
        },
        400,
      );
    }
    if (config.environment === 'production' || !repo) {
      return c.json(
        { error: { code: 'AUTH_NOT_CONFIGURED', message: 'Production requires Supabase Auth.', requestId: c.get('requestId') } },
        503,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Valid email and password are required.', requestId: c.get('requestId') } },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const stored = await repo.getUserByEmail(email);
    if (!stored || !stored.passwordHash || !(await verifyPassword(parsed.data.password, stored.passwordHash))) {
      return c.json(
        { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.', requestId: c.get('requestId') } },
        401,
      );
    }

    const token = await signSessionToken(
      { sub: stored.id, email: stored.email, role: stored.role, exp: Date.now() + 24 * 60 * 60 * 1000 },
      config.authSessionSecret,
    );
    await repo.appendAuditLog({
      actorId: stored.id,
      action: 'auth.login',
      resourceType: 'session',
      resourceId: stored.id,
      detail: `Signed in (${stored.role})`,
    });

    return c.json({ token, user: sanitizeUser(stored) });
  });

  // Blanket RBAC guard for ALL /api/v1/admin/* routes (exempting only POST /api/v1/admin/bootstrap)
  app.use('/api/v1/admin/*', async (c, next) => {
    if (c.req.path === '/api/v1/admin/bootstrap' && c.req.method === 'POST') {
      await next();
      return;
    }
    return authenticateRequest(c, next);
  });
  app.use('/api/v1/admin/*', async (c, next) => {
    if (c.req.path === '/api/v1/admin/bootstrap' && c.req.method === 'POST') {
      await next();
      return;
    }
    return requireAdmin(c, next);
  });

  // Secure explicit First-Admin Bootstrap (only works with server-only ADMIN_BOOTSTRAP_SECRET when zero admins exist)
  const bootstrapSchema = z.object({
    email: z.string().email().max(200),
    password: z.string().min(12).max(128).optional(),
    fullName: z.string().min(1).max(100).optional(),
  });

  app.post('/api/v1/admin/bootstrap', rateLimit(5, 60_000), async (c) => {
    const config = c.get('serverConfig');
    const repo = c.get('repo');
    if (!repo) {
      return c.json({ error: { code: 'DATABASE_NOT_CONFIGURED', message: 'Database unavailable.', requestId: c.get('requestId') } }, 503);
    }
    if (!config.adminBootstrapSecret || config.adminBootstrapSecret.length < 16) {
      return c.json(
        {
          error: {
            code: 'BOOTSTRAP_NOT_CONFIGURED',
            message: 'ADMIN_BOOTSTRAP_SECRET (>= 16 chars) is not configured on the server.',
            requestId: c.get('requestId'),
          },
        },
        503,
      );
    }

    const providedSecret = c.req.header('x-admin-bootstrap-secret') || '';
    if (!providedSecret || !timingSafeEqualStrings(providedSecret, config.adminBootstrapSecret)) {
      await repo.appendAuditLog({
        actorId: 'system',
        action: 'admin.bootstrap.rejected',
        resourceType: 'admin_bootstrap',
        resourceId: null,
        detail: 'Rejected admin bootstrap attempt due to missing or invalid secret.',
      });
      return c.json({ error: { code: 'FORBIDDEN', message: 'Invalid bootstrap secret.', requestId: c.get('requestId') } }, 403);
    }

    let existingAdmins: number;
    try {
      existingAdmins = await repo.countAdmins();
    } catch (err) {
      await repo
        .appendAuditLog({
          actorId: 'system',
          action: 'admin.bootstrap.verification_failed',
          resourceType: 'admin_bootstrap',
          resourceId: null,
          detail: `Blocked bootstrap because administrator count check failed: ${err instanceof Error ? err.message : 'database error'}`,
        })
        .catch(() => {});
      return c.json(
        {
          error: {
            code: 'BOOTSTRAP_VERIFICATION_FAILED',
            message: 'Unable to verify existing administrator state. Bootstrap is blocked.',
            requestId: c.get('requestId'),
          },
        },
        503,
      );
    }

    if (existingAdmins > 0) {
      await repo.appendAuditLog({
        actorId: 'system',
        action: 'admin.bootstrap.locked_attempt',
        resourceType: 'admin_bootstrap',
        resourceId: null,
        detail: 'Blocked bootstrap replay attempt because a platform administrator already exists.',
      });
      return c.json(
        { error: { code: 'ADMIN_ALREADY_EXISTS', message: 'Bootstrap locked: a platform administrator already exists.', requestId: c.get('requestId') } },
        409,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = bootstrapSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid bootstrap payload.', requestId: c.get('requestId') } },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const existingUser = await repo.getUserByEmail(email);

    if (existingUser) {
      const promoted = await repo.updateUserRole(existingUser.id, 'super_admin');
      await repo.appendAuditLog({
        actorId: existingUser.id,
        action: 'admin.bootstrap.promote',
        resourceType: 'profile',
        resourceId: existingUser.id,
        detail: `Bootstrapped initial super_admin for ${email}`,
      });
      return c.json({ user: promoted }, 200);
    }

    if (config.supabaseConfigured) {
      return c.json(
        {
          error: {
            code: 'USER_NOT_FOUND',
            message: 'Register the user via Supabase Auth first, then invoke bootstrap with their email to promote.',
            requestId: c.get('requestId'),
          },
        },
        404,
      );
    }

    if (!parsed.data.password) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Password (min 12 chars) required to create initial sandbox admin.', requestId: c.get('requestId') } },
        400,
      );
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(parsed.data.password);
    const created = await repo.createLocalUser(
      {
        id,
        email,
        fullName: parsed.data.fullName?.trim() || 'Platform Administrator',
        role: 'super_admin',
        language: 'en',
        experienceMode: 'advanced',
        memoryConsent: false,
        activePlan: 'enterprise',
        createdAt: new Date().toISOString(),
        passwordHash,
      },
      1000,
    );
    await repo.appendAuditLog({
      actorId: id,
      action: 'admin.bootstrap.create',
      resourceType: 'profile',
      resourceId: id,
      detail: `Created initial super_admin ${email}`,
    });

    return c.json({ user: created }, 201);
  });

  // =========================================================================
  // AUTHENTICATED USER ROUTES
  // =========================================================================
  app.use('/api/v1/auth/session', authenticateRequest);
  app.use('/api/v1/auth/profile', authenticateRequest);
  app.use('/api/v1/models', authenticateRequest);
  app.use('/api/v1/projects/*', authenticateRequest);
  app.use('/api/v1/projects', authenticateRequest);
  app.use('/api/v1/conversations/*', authenticateRequest);
  app.use('/api/v1/conversations', authenticateRequest);
  app.use('/api/v1/chat', authenticateRequest);
  app.use('/api/v1/brain/*', authenticateRequest);
  app.use('/api/v1/agents/*', authenticateRequest);
  app.use('/api/v1/agents', authenticateRequest);
  app.use('/api/v1/research/*', authenticateRequest);
  app.use('/api/v1/research', authenticateRequest);
  app.use('/api/v1/coder', authenticateRequest);
  app.use('/api/v1/knowledge/*', authenticateRequest);
  app.use('/api/v1/memories/*', authenticateRequest);
  app.use('/api/v1/memories', authenticateRequest);
  app.use('/api/v1/integrations', authenticateRequest);
  app.use('/api/v1/usage', authenticateRequest);

  app.get('/api/v1/auth/session', (c) => {
    return c.json({ user: c.get('currentUser') });
  });

  const profilePatchSchema = z.object({
    fullName: z.string().min(1).max(100).optional(),
    language: z.enum(['en', 'bn']).optional(),
    experienceMode: z.enum(['beginner', 'advanced']).optional(),
    memoryConsent: z.boolean().optional(),
  });

  app.patch('/api/v1/auth/profile', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const body = await c.req.json().catch(() => null);
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid profile update payload.', requestId: c.get('requestId') } },
        400,
      );
    }

    const updated = await repo.updateProfile(user.id, parsed.data);
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } }, 404);
    }

    return c.json({ user: updated });
  });

  app.get('/api/v1/models', (c) => {
    const config = c.get('serverConfig');
    return c.json({ models: getModelRegistry(config) });
  });

  // =========================================================================
  // PROJECTS CRUD (Strictly Tenant/User Isolated)
  // =========================================================================
  app.get('/api/v1/projects', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const items = await repo.listProjects(user.id);
    return c.json({ projects: items });
  });

  const projectSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    instructions: z.string().max(2000).optional(),
  });

  app.post('/api/v1/projects', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const body = await c.req.json().catch(() => null);
    const parsed = projectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Project name is required.' } }, 400);
    }
    const project = await repo.createProject(user.id, {
      name: parsed.data.name,
      description: parsed.data.description || '',
      instructions: parsed.data.instructions || '',
    });
    return c.json({ project }, 201);
  });

  const projectPatchSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    instructions: z.string().max(2000).optional(),
    archived: z.boolean().optional(),
  });

  app.patch('/api/v1/projects/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const body = await c.req.json().catch(() => null);
    const parsed = projectPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project update payload.' } }, 400);
    }
    const updated = await repo.updateProject(user.id, id, parsed.data);
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } }, 404);
    }
    return c.json({ project: updated });
  });

  app.delete('/api/v1/projects/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const deleted = await repo.deleteProject(user.id, id);
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } }, 404);
    }
    return c.json({ deleted: true });
  });

  // =========================================================================
  // CONVERSATIONS CRUD (Strictly Owned by Current User)
  // =========================================================================
  app.get('/api/v1/conversations', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const q = c.req.query('q') || '';
    const conversations = await repo.listConversations(user.id, q);
    return c.json({ conversations });
  });

  app.post('/api/v1/conversations', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const body = await c.req.json().catch(() => ({}));
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    if (projectId) {
      const proj = await repo.getProject(user.id, projectId);
      if (!proj) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Associated project not found.' } }, 404);
      }
    }
    const conversation = await repo.createConversation(user.id, {
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'New Conversation',
      projectId,
      routingMode: body.routingMode === 'manual' ? 'manual' : 'auto',
      preferredModel: typeof body.preferredModel === 'string' ? body.preferredModel : null,
    });
    return c.json({ conversation }, 201);
  });

  app.get('/api/v1/conversations/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const conversation = await repo.getConversation(user.id, id);
    if (!conversation) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
    }
    return c.json({ conversation });
  });

  const conversationPatchSchema = z.object({
    title: z.string().min(1).max(120).optional(),
    archived: z.boolean().optional(),
    routingMode: z.enum(['auto', 'manual']).optional(),
    preferredModel: z.string().max(120).nullable().optional(),
  });

  app.patch('/api/v1/conversations/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const body = await c.req.json().catch(() => null);
    const parsed = conversationPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid conversation update payload.' } }, 400);
    }
    const conversation = await repo.updateConversation(user.id, id, parsed.data);
    if (!conversation) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
    }
    return c.json({ conversation });
  });

  app.delete('/api/v1/conversations/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const deleted = await repo.deleteConversation(user.id, id);
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
    }
    return c.json({ deleted: true });
  });

  // =========================================================================
  // AVAREST BRAIN CHAT EXECUTION (Native Streaming & Atomic Credit Deduction)
  // =========================================================================
  const chatSchema = z.object({
    conversationId: z.string().optional(),
    projectId: z.string().nullable().optional(),
    prompt: z.string().min(1).max(32000),
    routingMode: z.enum(['auto', 'manual']).default('auto'),
    modelId: z.string().nullable().optional(),
    stream: z.boolean().optional(),
    useKnowledge: z.boolean().optional(),
    attachment: z
      .object({
        fileName: z.string().max(180),
        mimeType: z.string().max(100),
        content: z.string().max(100_000),
      })
      .optional(),
  });

  async function safeReleaseReservation(
    repo: WorkspaceRepository,
    userId: string,
    referenceId: string,
    reason: string,
  ): Promise<void> {
    try {
      await repo.releaseCreditReservation({ userId, referenceId, reason });
    } catch (releaseErr) {
      console.error(
        `[Avarest Credit Release Error] ref=${referenceId}:`,
        releaseErr instanceof Error ? releaseErr.message : 'Unknown release error',
      );
    }
  }

  app.post('/api/v1/chat', rateLimit(40, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const repo = c.get('repo')!;
    const requestId = c.get('requestId');
    const body = await c.req.json().catch(() => null);
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid chat request.', requestId } },
        400,
      );
    }

    const { prompt, routingMode, modelId, stream, useKnowledge, attachment } = parsed.data;
    if (attachment && !ALLOWED_DOC_MIMES.has(attachment.mimeType)) {
      return c.json(
        { error: { code: 'UNSUPPORTED_ATTACHMENT', message: 'Only plain text, Markdown, CSV, and JSON attachments are permitted.' } },
        400,
      );
    }

    // Load existing conversation if provided (before reserving credits)
    let conv: Conversation | null = null;
    let existingMessages: ChatMessage[] = [];
    if (parsed.data.conversationId) {
      const loaded = await repo.getConversation(user.id, parsed.data.conversationId);
      if (!loaded) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
      }
      conv = loaded;
      existingMessages = loaded.messages;
    }

    // Route via Avarest Brain prior to credit reservation
    const policies = await repo.listRoutingPolicies();
    const decision = routeWithAvarestBrain({
      prompt,
      config,
      mode: routingMode,
      requestedModelId: modelId,
      userPlan: user.activePlan,
      policies,
    });

    const fullUserText = attachment
      ? `${prompt}\n\n[Attached file: ${attachment.fileName}]\n${attachment.content}`
      : prompt;
    const costTier = getModelRegistry(config).find((m) => m.id === decision.selectedModel)?.costTier;
    const historyChars = existingMessages.slice(-14).map((m) => m.content).join('\n');
    const feature = stream ? 'chat_stream' : 'chat';
    const estimatedCredits = estimateReservationCredits({
      feature,
      promptText: `${historyChars}\n${fullUserText}`,
      costTier,
    });

    const assistantMsgId = crypto.randomUUID();
    const idemKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
    const referenceId = idemKey ? `${feature}:${idemKey}` : `chat:${assistantMsgId}`;

    let reserved;
    try {
      reserved = await repo.reserveCredits({
        userId: user.id,
        amount: estimatedCredits,
        feature,
        reason: `Chat (${decision.selectedModel})`,
        referenceId,
        ttlSeconds: DEFAULT_RESERVATION_TTL_SECONDS,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
        return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
      }
      throw err;
    }

    if (reserved.deduplicated) {
      const inProgress = reserved.reservation.status === 'reserved';
      return c.json(
        {
          error: {
            code: inProgress ? 'RESERVATION_IN_PROGRESS' : 'DUPLICATE_REQUEST',
            message: inProgress
              ? 'An identical chat request is already in progress.'
              : 'This idempotency key has already been processed.',
            requestId,
          },
        },
        409,
      );
    }

    let providerMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    let systemParts: string[];
    let userMsg: ChatMessage;
    let conversationId: string;

    try {
      if (!conv) {
        conv = await repo.createConversation(user.id, {
          title: prompt.slice(0, 60) + (prompt.length > 60 ? '...' : ''),
          projectId: parsed.data.projectId || null,
          routingMode,
          preferredModel: modelId || null,
        });
      }
      conversationId = conv.id;

      // Build context: system instructions + project instructions + optional RAG + consent-based memories
      systemParts = [
        'You are Avarest One, an AI workspace powered by Avarest Brain. Respond accurately, clearly, and concisely.',
      ];
      if (conv.projectId) {
        const proj = await repo.getProject(user.id, conv.projectId);
        if (proj && proj.instructions) {
          systemParts.push(`Project instructions (${proj.name}):\n${proj.instructions}`);
        }
      }
      if (user.memoryConsent) {
        const userMems = await repo.listMemories(user.id);
        if (userMems.length > 0) {
          systemParts.push(
            `Authorized user memory context:\n${userMems.slice(0, 10).map((m) => `- ${m.fact}`).join('\n')}`,
          );
        }
      }
      if (useKnowledge) {
        const matches = await repo.searchKnowledgeChunks(user.id, prompt, 3);
        if (matches.length > 0) {
          systemParts.push(
            `Retrieved workspace knowledge:\n${matches.map((m) => `[${m.fileName}#${m.chunkIndex}]: ${m.content}`).join('\n\n')}`,
          );
        }
      }

      userMsg = {
        id: crypto.randomUUID(),
        conversationId,
        role: 'user',
        content: fullUserText,
        inputTokens: 0,
        outputTokens: 0,
        citations: [],
        createdAt: new Date().toISOString(),
      };
      await repo.addMessage(user.id, userMsg);

      providerMessages = [...existingMessages, userMsg]
        .slice(-14)
        .map((m) => ({ role: m.role, content: m.content }));
    } catch (err) {
      await safeReleaseReservation(repo, user.id, referenceId, 'Chat setup failed before execution');
      throw err;
    }

    const startedAt = Date.now();

    if (stream) {
      const encoder = new TextEncoder();
      let settled = false;
      let streamCanceled = false;

      const releaseOnce = async (reason: string) => {
        if (settled) return;
        settled = true;
        await safeReleaseReservation(repo, user.id, referenceId, reason);
      };

      const bodyStream = new ReadableStream({
        async start(controller) {
          let closed = false;
          const safeEnqueue = (chunk: Uint8Array) => {
            if (closed || streamCanceled || c.req.raw.signal.aborted) return;
            try {
              controller.enqueue(chunk);
            } catch {
              closed = true;
            }
          };
          const safeClose = () => {
            if (closed) return;
            closed = true;
            try {
              controller.close();
            } catch {
              // stream already closed or canceled by peer
            }
          };
          const sendEvent = (event: string, data: unknown) => {
            safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          sendEvent('meta', {
            conversationId,
            decision,
          });

          try {
            let finalResult = null;
            for await (const chunk of streamProviderCompletion({
              providerId: decision.selectedProvider,
              modelId: decision.selectedModel,
              messages: providerMessages,
              systemInstruction: systemParts.join('\n\n'),
              config,
              signal: c.req.raw.signal,
            })) {
              if (c.req.raw.signal.aborted || streamCanceled) break;
              if (chunk.delta) {
                sendEvent('delta', { delta: chunk.delta });
              }
              if (chunk.done && chunk.result) {
                finalResult = chunk.result;
              }
            }

            if (c.req.raw.signal.aborted || streamCanceled || !finalResult) {
              await releaseOnce('Chat stream canceled or interrupted before completion');
              await repo
                .addRoutingLog({
                  id: crypto.randomUUID(),
                  userId: user.id,
                  taskCategory: decision.taskCategory,
                  selectedProvider: decision.selectedProvider,
                  selectedModel: decision.selectedModel,
                  reason: 'Stream canceled by client before completion',
                  latencyMs: Date.now() - startedAt,
                  fallbackUsed: decision.fallbackUsed,
                  status: 'error',
                  createdAt: new Date().toISOString(),
                })
                .catch(() => {});
              safeClose();
              return;
            }

            const text = finalResult.text || '';
            const inputTokens = finalResult.inputTokens || 0;
            const outputTokens = finalResult.outputTokens || 0;
            const assistantMsg: ChatMessage = {
              id: assistantMsgId,
              conversationId,
              role: 'assistant',
              content: text,
              providerId: decision.selectedProvider,
              modelId: decision.selectedModel,
              taskCategory: decision.taskCategory,
              routingReason: decision.reason,
              inputTokens,
              outputTokens,
              usageIsEstimated: finalResult.usageIsEstimated ?? true,
              citations: finalResult.citations || [],
              createdAt: new Date().toISOString(),
            };
            await repo.addMessage(user.id, assistantMsg);

            const actualCost = calculateActualCreditCost({
              feature: 'chat_stream',
              inputTokens,
              outputTokens,
            });
            const finalized = await repo.finalizeCreditReservation({
              userId: user.id,
              referenceId,
              actualAmount: actualCost,
              reason: `Chat (${decision.selectedModel})`,
            });
            settled = true;

            await repo.recordUsage({
              userId: user.id,
              providerId: decision.selectedProvider,
              modelId: decision.selectedModel,
              feature: 'chat',
              inputTokens,
              outputTokens,
              creditsCharged: finalized.reservation.actualAmount,
            });
            await repo.addRoutingLog({
              id: crypto.randomUUID(),
              userId: user.id,
              taskCategory: decision.taskCategory,
              selectedProvider: decision.selectedProvider,
              selectedModel: decision.selectedModel,
              reason: decision.reason,
              latencyMs: Date.now() - startedAt,
              fallbackUsed: decision.fallbackUsed,
              status: decision.fallbackUsed ? 'fallback' : 'success',
              createdAt: new Date().toISOString(),
            });

            sendEvent('done', {
              message: assistantMsg,
              creditsCharged: finalized.reservation.actualAmount,
              balanceAfter: finalized.balanceAfter,
            });
            safeClose();
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Streaming failed';
            await releaseOnce(`Chat stream error: ${msg}`);
            await repo
              .addRoutingLog({
                id: crypto.randomUUID(),
                userId: user.id,
                taskCategory: decision.taskCategory,
                selectedProvider: decision.selectedProvider,
                selectedModel: decision.selectedModel,
                reason: msg,
                latencyMs: Date.now() - startedAt,
                fallbackUsed: decision.fallbackUsed,
                status: 'error',
                createdAt: new Date().toISOString(),
              })
              .catch(() => {});
            sendEvent('error', { message: msg });
            safeClose();
          }
        },
        cancel() {
          streamCanceled = true;
          const cleanupPromise = releaseOnce('Chat stream canceled by client');
          try {
            c.executionCtx?.waitUntil(cleanupPromise);
          } catch {
            // Ignored outside Cloudflare Worker ExecutionContext (e.g. Vitest/Node)
          }
        },
      });

      return new Response(bodyStream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        },
      });
    }

    // Non-streaming execution with atomic reservation -> finalize/release
    try {
      const completion = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        messages: providerMessages,
        systemInstruction: systemParts.join('\n\n'),
        config,
      });

      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        conversationId,
        role: 'assistant',
        content: completion.text,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        taskCategory: decision.taskCategory,
        routingReason: decision.reason,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        usageIsEstimated: completion.usageIsEstimated,
        citations: completion.citations,
        createdAt: new Date().toISOString(),
      };
      await repo.addMessage(user.id, assistantMsg);

      const actualCost = calculateActualCreditCost({
        feature: 'chat',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
      const finalized = await repo.finalizeCreditReservation({
        userId: user.id,
        referenceId,
        actualAmount: actualCost,
        reason: `Chat (${decision.selectedModel})`,
      });

      await repo.recordUsage({
        userId: user.id,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        feature: 'chat',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        creditsCharged: finalized.reservation.actualAmount,
      });
      await repo.addRoutingLog({
        id: crypto.randomUUID(),
        userId: user.id,
        taskCategory: decision.taskCategory,
        selectedProvider: decision.selectedProvider,
        selectedModel: decision.selectedModel,
        reason: decision.reason,
        latencyMs: Date.now() - startedAt,
        fallbackUsed: decision.fallbackUsed,
        status: decision.fallbackUsed ? 'fallback' : 'success',
        createdAt: new Date().toISOString(),
      });

      return c.json({
        conversationId,
        decision,
        userMessage: userMsg,
        assistantMessage: assistantMsg,
        creditsCharged: finalized.reservation.actualAmount,
        balanceAfter: finalized.balanceAfter,
      });
    } catch (err) {
      await safeReleaseReservation(
        repo,
        user.id,
        referenceId,
        err instanceof Error ? `Chat failed: ${err.message}` : 'Chat execution failed',
      );
      throw err;
    }
  });

  // =========================================================================
  // AVAREST BRAIN LOGS & POLICIES
  // =========================================================================
  app.get('/api/v1/brain/logs', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const logs = await repo.listRoutingLogs(user.id, 50);
    return c.json({ logs });
  });

  app.get('/api/v1/brain/policies', async (c) => {
    const repo = c.get('repo')!;
    const policies = await repo.listRoutingPolicies();
    return c.json({ policies });
  });

  // =========================================================================
  // DEEP RESEARCH
  // =========================================================================
  const researchSchema = z.object({
    query: z.string().min(3).max(2000),
  });

  app.get('/api/v1/research', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const reports = await repo.listResearchReports(user.id);
    return c.json({ reports });
  });

  app.post('/api/v1/research', rateLimit(15, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const repo = c.get('repo')!;
    const requestId = c.get('requestId');
    const body = await c.req.json().catch(() => null);
    const parsed = researchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Research query must be at least 3 characters.' } }, 400);
    }

    const policies = await repo.listRoutingPolicies();
    const decision = routeWithAvarestBrain({
      prompt: parsed.data.query,
      config,
      mode: 'auto',
      explicitTask: 'research',
      userPlan: user.activePlan,
      policies,
    });

    const costTier = getModelRegistry(config).find((m) => m.id === decision.selectedModel)?.costTier;
    const estimatedCredits = estimateReservationCredits({
      feature: 'research',
      promptText: parsed.data.query,
      costTier,
    });
    const reportId = crypto.randomUUID();
    const idemKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
    const referenceId = idemKey ? `research:${idemKey}` : `research:${reportId}`;

    let reserved;
    try {
      reserved = await repo.reserveCredits({
        userId: user.id,
        amount: estimatedCredits,
        feature: 'research',
        reason: `Deep Research (${decision.selectedModel})`,
        referenceId,
        ttlSeconds: DEFAULT_RESERVATION_TTL_SECONDS,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
        return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
      }
      throw err;
    }

    if (reserved.deduplicated) {
      const inProgress = reserved.reservation.status === 'reserved';
      return c.json(
        {
          error: {
            code: inProgress ? 'RESERVATION_IN_PROGRESS' : 'DUPLICATE_REQUEST',
            message: inProgress
              ? 'An identical research request is already in progress.'
              : 'This idempotency key has already been processed.',
            requestId,
          },
        },
        409,
      );
    }

    try {
      const completion = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        enableWebSearch: decision.selectedProvider === 'gemini',
        systemInstruction:
          'You are the Avarest One Deep Research Analyst. Produce a structured research brief clearly separating verified facts/sources from analytical synthesis. Never fabricate URLs or citations.',
        messages: [{ role: 'user', content: parsed.data.query }],
        config,
      });

      const report: ResearchReport = {
        id: reportId,
        userId: user.id,
        query: parsed.data.query,
        reportMarkdown: completion.text,
        citations: completion.citations,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        groundingActive: completion.groundingActive,
        createdAt: new Date().toISOString(),
      };
      await repo.createResearchReport(report);

      const actualCost = calculateActualCreditCost({
        feature: 'research',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
      const finalized = await repo.finalizeCreditReservation({
        userId: user.id,
        referenceId,
        actualAmount: actualCost,
        reason: `Deep Research (${decision.selectedModel})`,
      });
      await repo.recordUsage({
        userId: user.id,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        feature: 'research',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        creditsCharged: finalized.reservation.actualAmount,
      });

      return c.json({ report, creditsCharged: finalized.reservation.actualAmount, balanceAfter: finalized.balanceAfter }, 201);
    } catch (err) {
      await safeReleaseReservation(
        repo,
        user.id,
        referenceId,
        err instanceof Error ? `Research failed: ${err.message}` : 'Deep Research execution failed',
      );
      throw err;
    }
  });

  // =========================================================================
  // AI CODER
  // =========================================================================
  const coderSchema = z.object({
    taskType: z.enum(['generate', 'explain', 'debug', 'refactor', 'review']),
    language: z.string().max(40).default('TypeScript'),
    prompt: z.string().min(3).max(16000),
    codeContext: z.string().max(24000).optional(),
  });

  app.post('/api/v1/coder', rateLimit(25, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const repo = c.get('repo')!;
    const requestId = c.get('requestId');
    const body = await c.req.json().catch(() => null);
    const parsed = coderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid AI Coder request.' } }, 400);
    }

    const policies = await repo.listRoutingPolicies();
    const decision = routeWithAvarestBrain({
      prompt: parsed.data.prompt,
      config,
      mode: 'auto',
      explicitTask: 'coding',
      userPlan: user.activePlan,
      policies,
    });

    const composedPrompt = [
      `Task Mode: ${parsed.data.taskType.toUpperCase()}`,
      `Target Language: ${parsed.data.language}`,
      `Request: ${parsed.data.prompt}`,
      parsed.data.codeContext ? `\nCode Context:\n\`\`\`\n${parsed.data.codeContext}\n\`\`\`` : '',
    ].join('\n');

    const costTier = getModelRegistry(config).find((m) => m.id === decision.selectedModel)?.costTier;
    const estimatedCredits = estimateReservationCredits({
      feature: 'coder',
      promptText: composedPrompt,
      costTier,
    });
    const coderRefId = crypto.randomUUID();
    const idemKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
    const referenceId = idemKey ? `coder:${idemKey}` : `coder:${coderRefId}`;

    let reserved;
    try {
      reserved = await repo.reserveCredits({
        userId: user.id,
        amount: estimatedCredits,
        feature: 'coder',
        reason: `AI Coder: ${parsed.data.taskType}`,
        referenceId,
        ttlSeconds: DEFAULT_RESERVATION_TTL_SECONDS,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
        return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
      }
      throw err;
    }

    if (reserved.deduplicated) {
      const inProgress = reserved.reservation.status === 'reserved';
      return c.json(
        {
          error: {
            code: inProgress ? 'RESERVATION_IN_PROGRESS' : 'DUPLICATE_REQUEST',
            message: inProgress
              ? 'An identical AI Coder request is already in progress.'
              : 'This idempotency key has already been processed.',
            requestId,
          },
        },
        409,
      );
    }

    try {
      const completion = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        systemInstruction:
          'You are Avarest One AI Coder. Provide clean, production-grade code, root-cause debugging, and safe patch proposals. External repository writes always require explicit human approval.',
        messages: [{ role: 'user', content: composedPrompt }],
        config,
      });

      const actualCost = calculateActualCreditCost({
        feature: 'coder',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
      const finalized = await repo.finalizeCreditReservation({
        userId: user.id,
        referenceId,
        actualAmount: actualCost,
        reason: `AI Coder: ${parsed.data.taskType}`,
      });
      await repo.recordUsage({
        userId: user.id,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        feature: 'coder',
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        creditsCharged: finalized.reservation.actualAmount,
      });

      return c.json({
        output: completion.text,
        decision,
        requiresHumanApprovalForExternalWrite: true,
        creditsCharged: finalized.reservation.actualAmount,
        balanceAfter: finalized.balanceAfter,
        tokens: {
          input: completion.inputTokens,
          output: completion.outputTokens,
          usageIsEstimated: completion.usageIsEstimated,
        },
      });
    } catch (err) {
      await safeReleaseReservation(
        repo,
        user.id,
        referenceId,
        err instanceof Error ? `AI Coder failed: ${err.message}` : 'AI Coder execution failed',
      );
      throw err;
    }
  });

  // =========================================================================
  // AI AGENTS & HUMAN APPROVAL CHECKPOINTS
  // =========================================================================
  app.get('/api/v1/agents', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const agents = await repo.listAgents(user.id);
    return c.json({ agents });
  });

  const agentSchema = z.object({
    name: z.string().min(2).max(100),
    category: z.enum(['research', 'coding', 'browser', 'marketing', 'business', 'document', 'automation']),
    instructions: z.string().min(5).max(3000),
    allowedTools: z.array(z.string().max(60)).max(10).default([]),
    maxSteps: z.number().int().min(1).max(25).default(5),
    requireApproval: z.boolean().default(true),
  });

  app.post('/api/v1/agents', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const body = await c.req.json().catch(() => null);
    const parsed = agentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid agent configuration.' } }, 400);
    }

    const agent: AgentConfig = {
      id: crypto.randomUUID(),
      userId: user.id,
      ...parsed.data,
      createdAt: new Date().toISOString(),
    };
    await repo.createAgent(agent);
    return c.json({ agent }, 201);
  });

  app.get('/api/v1/agents/runs', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const runs = await repo.listAgentRuns(user.id);
    return c.json({ runs });
  });

  app.post('/api/v1/agents/:id/run', rateLimit(15, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const repo = c.get('repo')!;
    const requestId = c.get('requestId');
    const agentId = c.req.param('id') || '';
    const agent = await repo.getAgent(user.id, agentId);
    if (!agent) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found.' } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const inputTask = typeof body.inputTask === 'string' ? body.inputTask.trim() : '';
    if (!inputTask) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'inputTask is required.' } }, 400);
    }

    const now = new Date().toISOString();
    const runId = crypto.randomUUID();

    if (agent.requireApproval) {
      const run: AgentRun = {
        id: runId,
        agentId: agent.id,
        agentName: agent.name,
        userId: user.id,
        inputTask,
        status: 'awaiting_approval',
        outputSummary: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      await repo.createAgentRun(run);
      const approval: AgentApproval = {
        id: crypto.randomUUID(),
        runId: run.id,
        userId: user.id,
        actionType: `execute_${agent.category}_agent`,
        actionSummary: `Run agent "${agent.name}" (max ${agent.maxSteps} steps) for: ${inputTask.slice(0, 140)}`,
        decision: 'pending',
        decidedAt: null,
        createdAt: now,
      };
      await repo.createApproval(approval);
      return c.json({ run: { ...run, pendingApproval: approval } }, 201);
    }

    // Immediate execution requires atomic credit reservation BEFORE running AI provider
    const policies = await repo.listRoutingPolicies();
    const decision = routeWithAvarestBrain({
      prompt: inputTask,
      config,
      mode: 'auto',
      userPlan: user.activePlan,
      policies,
    });
    const costTier = getModelRegistry(config).find((m) => m.id === decision.selectedModel)?.costTier;
    const estimatedCredits = estimateReservationCredits({
      feature: 'agent_immediate',
      promptText: `${agent.instructions}\n${inputTask}`,
      costTier,
    });
    const idemKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key'));
    const referenceId = idemKey ? `agent_immediate:${idemKey}` : `agent-run:${runId}`;

    let reserved;
    try {
      reserved = await repo.reserveCredits({
        userId: user.id,
        amount: estimatedCredits,
        feature: 'agent_immediate',
        reason: `Agent execution: ${agent.name}`,
        referenceId,
        ttlSeconds: DEFAULT_RESERVATION_TTL_SECONDS,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
        return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
      }
      throw err;
    }

    if (reserved.deduplicated) {
      const inProgress = reserved.reservation.status === 'reserved';
      return c.json(
        {
          error: {
            code: inProgress ? 'RESERVATION_IN_PROGRESS' : 'DUPLICATE_REQUEST',
            message: inProgress
              ? 'An identical agent execution is already in progress.'
              : 'This idempotency key has already been processed.',
            requestId,
          },
        },
        409,
      );
    }

    const run: AgentRun = {
      id: runId,
      agentId: agent.id,
      agentName: agent.name,
      userId: user.id,
      inputTask,
      status: 'running',
      outputSummary: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await repo.createAgentRun(run);

    const startedAt = Date.now();
    try {
      const res = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        systemInstruction: `Agent "${agent.name}" (${agent.category}). Instructions: ${agent.instructions}`,
        messages: [{ role: 'user', content: inputTask }],
        config,
      });

      const actualCost = calculateActualCreditCost({
        feature: 'agent_immediate',
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
      await repo.finalizeCreditReservation({
        userId: user.id,
        referenceId,
        actualAmount: actualCost,
        reason: `Agent execution: ${agent.name}`,
      });
      await repo.recordUsage({
        userId: user.id,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        feature: 'agent_immediate',
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        creditsCharged: actualCost,
      });
      await repo.addRoutingLog({
        id: crypto.randomUUID(),
        userId: user.id,
        taskCategory: decision.taskCategory,
        selectedProvider: decision.selectedProvider,
        selectedModel: decision.selectedModel,
        reason: decision.reason,
        latencyMs: Date.now() - startedAt,
        fallbackUsed: decision.fallbackUsed,
        status: decision.fallbackUsed ? 'fallback' : 'success',
        createdAt: new Date().toISOString(),
      });

      run.status = 'completed';
      run.outputSummary = res.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Agent execution failed';
      await safeReleaseReservation(repo, user.id, referenceId, `Agent execution failed: ${msg}`);
      run.status = 'failed';
      run.errorMessage = msg;
    }
    const updated = await repo.updateAgentRun(run.id, {
      status: run.status,
      outputSummary: run.outputSummary,
      errorMessage: run.errorMessage,
    });
    return c.json({ run: updated || run }, 201);
  });

  app.post('/api/v1/agents/approvals/:id/decide', async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const repo = c.get('repo')!;
    const requestId = c.get('requestId');
    const approvalId = c.req.param('id') || '';
    const approval = await repo.getApproval(user.id, approvalId);
    if (!approval) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Approval checkpoint not found.' } }, 404);
    }
    if (approval.decision !== 'pending') {
      return c.json({ error: { code: 'ALREADY_DECIDED', message: 'This approval was already resolved.' } }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Decision must be "approved" or "rejected".' } }, 400);
    }

    const run = await repo.getAgentRun(user.id, approval.runId);
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Associated run not found.' } }, 404);
    }

    if (body.decision === 'rejected') {
      const resolvedApproval = await repo.resolveApproval(approval.id, 'rejected', user.id);
      if (!resolvedApproval) {
        return c.json({ error: { code: 'ALREADY_DECIDED', message: 'This approval was already resolved.' } }, 400);
      }
      const updated = await repo.updateAgentRun(run.id, {
        status: 'canceled',
        outputSummary: 'Execution canceled at human approval checkpoint.',
      });
      return c.json({ approval: resolvedApproval, run: updated || run });
    }

    const agent = await repo.getAgent(user.id, run.agentId);
    const policies = await repo.listRoutingPolicies();
    const decision = routeWithAvarestBrain({
      prompt: run.inputTask,
      config,
      mode: 'auto',
      userPlan: user.activePlan,
      policies,
    });
    const costTier = getModelRegistry(config).find((m) => m.id === decision.selectedModel)?.costTier;
    const estimatedCredits = estimateReservationCredits({
      feature: 'agent_approval',
      promptText: `${agent?.instructions || ''}\n${run.inputTask}`,
      costTier,
    });

    // Pre-check before claiming approval so insufficient balance preserves pending checkpoint
    const currentBalance = await repo.getCreditBalance(user.id);
    if (currentBalance < estimatedCredits) {
      return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
    }

    // Atomically claim pending -> approved so concurrent approvals cannot double-execute
    const resolvedApproval = await repo.resolveApproval(approval.id, 'approved', user.id);
    if (!resolvedApproval) {
      return c.json({ error: { code: 'ALREADY_DECIDED', message: 'This approval was already resolved.' } }, 400);
    }

    const referenceId = `agent-approval:${run.id}`;
    let reserved;
    try {
      reserved = await repo.reserveCredits({
        userId: user.id,
        amount: estimatedCredits,
        feature: 'agent_approval',
        reason: `Approved agent execution: ${run.agentName}`,
        referenceId,
        ttlSeconds: DEFAULT_RESERVATION_TTL_SECONDS,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
        await repo.updateAgentRun(run.id, {
          status: 'failed',
          errorMessage: 'Insufficient workspace credits.',
        });
        return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.', requestId } }, 402);
      }
      throw err;
    }

    if (reserved.deduplicated) {
      return c.json(
        {
          error: {
            code: 'ALREADY_DECIDED',
            message: 'This agent approval run has already been reserved or executed.',
            requestId,
          },
        },
        409,
      );
    }

    const startedAt = Date.now();
    let nextStatus: AgentRun['status'] = 'completed';
    let outputSummary: string | null = null;
    let errorMessage: string | null = null;
    try {
      const res = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        systemInstruction: `Agent "${agent?.name || run.agentName}". Instructions: ${agent?.instructions || ''}`,
        messages: [{ role: 'user', content: run.inputTask }],
        config,
      });

      const actualCost = calculateActualCreditCost({
        feature: 'agent_approval',
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
      });
      await repo.finalizeCreditReservation({
        userId: user.id,
        referenceId,
        actualAmount: actualCost,
        reason: `Approved agent execution: ${run.agentName}`,
      });
      await repo.recordUsage({
        userId: user.id,
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        feature: 'agent_approval',
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        creditsCharged: actualCost,
      });
      await repo.addRoutingLog({
        id: crypto.randomUUID(),
        userId: user.id,
        taskCategory: decision.taskCategory,
        selectedProvider: decision.selectedProvider,
        selectedModel: decision.selectedModel,
        reason: decision.reason,
        latencyMs: Date.now() - startedAt,
        fallbackUsed: decision.fallbackUsed,
        status: decision.fallbackUsed ? 'fallback' : 'success',
        createdAt: new Date().toISOString(),
      });

      outputSummary = res.text;
    } catch (err) {
      nextStatus = 'failed';
      errorMessage = err instanceof Error ? err.message : 'Agent execution failed';
      await safeReleaseReservation(repo, user.id, referenceId, `Approved agent execution failed: ${errorMessage}`);
    }
    const updatedRun = await repo.updateAgentRun(run.id, { status: nextStatus, outputSummary, errorMessage });
    return c.json({ approval: resolvedApproval, run: updatedRun || run });
  });

  app.post('/api/v1/agents/runs/:id/cancel', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const runId = c.req.param('id') || '';
    const existing = await repo.getAgentRun(user.id, runId);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found.' } }, 404);
    }
    const run = await repo.updateAgentRun(runId, { status: 'canceled' });
    return c.json({ run });
  });

  // =========================================================================
  // KNOWLEDGE & CONSENT-BASED MEMORY
  // =========================================================================
  app.get('/api/v1/knowledge/documents', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const documents = await repo.listKnowledgeDocs(user.id);
    return c.json({ documents });
  });

  const docUploadSchema = z.object({
    fileName: z.string().min(1).max(180),
    mimeType: z.string().max(100),
    content: z.string().min(1).max(1_000_000),
  });

  app.post('/api/v1/knowledge/documents', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const body = await c.req.json().catch(() => null);
    const parsed = docUploadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid document payload.' } }, 400);
    }
    if (!ALLOWED_DOC_MIMES.has(parsed.data.mimeType)) {
      return c.json(
        { error: { code: 'UNSUPPORTED_MIME', message: 'Allowed document types: text/plain, text/markdown, text/csv, application/json.' } },
        400,
      );
    }
    const chunks = chunkTextDocument(parsed.data.content);
    if (chunks.length === 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Document text cannot be empty.' } }, 400);
    }

    const doc = await repo.uploadKnowledgeDoc({
      userId: user.id,
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      content: parsed.data.content,
    });
    return c.json({ document: doc }, 201);
  });

  app.delete('/api/v1/knowledge/documents/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const deleted = await repo.deleteKnowledgeDoc(user.id, id);
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
    }
    return c.json({ deleted: true });
  });

  app.post('/api/v1/knowledge/search', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const body = await c.req.json().catch(() => ({}));
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const matches = await repo.searchKnowledgeChunks(user.id, query, 8);
    return c.json({ matches, retrievalMode: 'keyword_rank' });
  });

  app.get('/api/v1/memories', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const memories = await repo.listMemories(user.id);
    return c.json({
      consentEnabled: user.memoryConsent,
      memories,
    });
  });

  app.post('/api/v1/memories', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    if (!user.memoryConsent) {
      return c.json(
        { error: { code: 'CONSENT_REQUIRED', message: 'Enable memory consent in settings before saving personal memories.' } },
        403,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const fact = typeof body.fact === 'string' ? body.fact.trim() : '';
    if (fact.length < 3 || fact.length > 500) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Memory fact must be 3–500 characters.' } }, 400);
    }
    const memory = await repo.addMemory(user.id, fact);
    return c.json({ memory }, 201);
  });

  app.delete('/api/v1/memories/:id', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    await repo.deleteMemory(user.id, id);
    return c.json({ deleted: true });
  });

  // =========================================================================
  // CONNECTED APPS & MCP (Honest Server Verification)
  // =========================================================================
  app.get('/api/v1/integrations', (c) => {
    const config = c.get('serverConfig');
    const integrations: ConnectedAccount[] = [
      {
        id: 'github',
        provider: 'github',
        displayName: 'GitHub',
        oauthConfigured: config.oauth.githubConfigured,
        status: config.oauth.githubConfigured ? 'disconnected' : 'not_configured',
        scopes: ['repo:read', 'read:user'],
        detail: config.oauth.githubConfigured
          ? 'OAuth configured on server; user authorization not yet linked.'
          : 'Requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET server bindings.',
      },
      {
        id: 'google_drive',
        provider: 'google_drive',
        displayName: 'Google Drive',
        oauthConfigured: config.oauth.googleConfigured,
        status: config.oauth.googleConfigured ? 'disconnected' : 'not_configured',
        scopes: ['drive.readonly'],
        detail: config.oauth.googleConfigured
          ? 'Google OAuth ready; authorize account to connect.'
          : 'Requires Google Workspace OAuth client configuration.',
      },
      {
        id: 'gmail',
        provider: 'gmail',
        displayName: 'Gmail',
        oauthConfigured: config.oauth.googleConfigured,
        status: config.oauth.googleConfigured ? 'disconnected' : 'not_configured',
        scopes: ['gmail.readonly'],
        detail: config.oauth.googleConfigured
          ? 'Google OAuth ready; authorize account to connect.'
          : 'Requires Google Workspace OAuth client configuration.',
      },
      {
        id: 'google_calendar',
        provider: 'google_calendar',
        displayName: 'Google Calendar',
        oauthConfigured: config.oauth.googleConfigured,
        status: config.oauth.googleConfigured ? 'disconnected' : 'not_configured',
        scopes: ['calendar.readonly'],
        detail: config.oauth.googleConfigured
          ? 'Google OAuth ready; authorize account to connect.'
          : 'Requires Google Workspace OAuth client configuration.',
      },
      {
        id: 'mcp',
        provider: 'mcp',
        displayName: 'Model Context Protocol (MCP)',
        oauthConfigured: false,
        status: 'not_configured',
        scopes: ['tools:list', 'tools:call'],
        detail: 'No external MCP servers registered in this environment.',
      },
    ];
    return c.json({ integrations });
  });

  // =========================================================================
  // USAGE & BILLING LEDGER
  // =========================================================================
  app.get('/api/v1/usage', async (c) => {
    const user = c.get('currentUser');
    const repo = c.get('repo')!;
    const usage = await repo.getUserUsageSummary(user.id);
    return c.json({ usage });
  });

  // =========================================================================
  // PROTECTED ADMIN CONSOLE (Blanket Server-Side RBAC for /api/v1/admin/*)
  // =========================================================================

  app.post('/api/v1/admin/credits/reconcile', async (c) => {
    const actor = c.get('currentUser');
    const repo = c.get('repo')!;
    const result = await repo.reconcileExpiredReservations({ limit: 250 });
    await repo.appendAuditLog({
      actorId: actor.id,
      action: 'admin.credits.reconcile_expired',
      resourceType: 'credit_reservation',
      resourceId: null,
      detail: `Reconciled ${result.reconciledCount} expired reservations (refunded ${result.refundedTotal} credits)`,
    });
    return c.json(result);
  });

  app.get('/api/v1/admin/overview', async (c) => {
    const config = c.get('serverConfig');
    const repo = c.get('repo')!;
    const counts = await repo.getAdminOverview();
    return c.json({
      environment: config.environment,
      ...counts,
      providers: getProviderSummary(config),
    });
  });

  app.get('/api/v1/admin/provider-health', async (c) => {
    const config = c.get('serverConfig');
    const results = await Promise.all(
      ACTIVE_PROVIDER_IDS.map((pid) => probeProviderConnectivity(pid, config)),
    );
    return c.json({ providers: results });
  });

  app.get('/api/v1/admin/users', async (c) => {
    const repo = c.get('repo')!;
    const users = await repo.listUsersWithCredits();
    return c.json({ users });
  });

  app.patch('/api/v1/admin/users/:id/role', async (c) => {
    const actor = c.get('currentUser');
    const repo = c.get('repo')!;
    const targetId = c.req.param('id') || '';
    const body = await c.req.json().catch(() => ({}));
    if (body.role !== 'user' && body.role !== 'admin' && body.role !== 'super_admin') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid role.' } }, 400);
    }
    const updated = await repo.updateUserRole(targetId, body.role);
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'User not found.' } }, 404);
    }
    await repo.appendAuditLog({
      actorId: actor.id,
      action: 'admin.user.role_updated',
      resourceType: 'profile',
      resourceId: updated.id,
      detail: `Role changed to ${body.role} for ${updated.email}`,
    });
    return c.json({ user: updated });
  });

  app.get('/api/v1/admin/audit-logs', async (c) => {
    const repo = c.get('repo')!;
    const auditLogs = await repo.listAuditLogs(100);
    return c.json({ auditLogs });
  });

  app.get('/api/v1/admin/flags', async (c) => {
    const repo = c.get('repo')!;
    const flags = await repo.listFeatureFlags();
    return c.json({ flags });
  });

  app.patch('/api/v1/admin/flags/:key', async (c) => {
    const actor = c.get('currentUser');
    const repo = c.get('repo')!;
    const key = c.req.param('key') || '';
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'enabled boolean is required.' } }, 400);
    }
    const flag = await repo.toggleFeatureFlag(key, body.enabled);
    if (!flag) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Feature flag not found.' } }, 404);
    }
    await repo.appendAuditLog({
      actorId: actor.id,
      action: 'admin.flag.updated',
      resourceType: 'feature_flag',
      resourceId: key,
      detail: `Set ${key} = ${body.enabled}`,
    });
    return c.json({ flag });
  });

  const policyPatchSchema = z.object({
    active: z.boolean().optional(),
    preferredModelId: z.string().min(1).max(120).optional(),
    fallbackModelId: z.string().min(1).max(120).optional(),
  });

  app.patch('/api/v1/admin/policies/:id', async (c) => {
    const actor = c.get('currentUser');
    const repo = c.get('repo')!;
    const id = c.req.param('id') || '';
    const body = await c.req.json().catch(() => null);
    const parsed = policyPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid routing policy payload.' } }, 400);
    }
    const policy = await repo.updateRoutingPolicy(id, parsed.data);
    if (!policy) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Routing policy not found.' } }, 404);
    }
    await repo.appendAuditLog({
      actorId: actor.id,
      action: 'admin.policy.updated',
      resourceType: 'routing_policy',
      resourceId: id,
      detail: `Updated policy ${policy.name}`,
    });
    return c.json({ policy });
  });

  // =========================================================================
  // NOT FOUND: JSON 404 FOR UNKNOWN API ROUTES; WORKER ASSETS + SPA FALLBACK
  // =========================================================================
  const STATIC_ASSET_EXT_RE =
    /\.(?:js|mjs|css|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|json|webmanifest|txt|xml)$/i;

  app.notFound(async (c) => {
    const path = c.req.path;
    const requestId = c.get('requestId');

    // Never return SPA HTML for unknown API routes
    if (path === '/api' || path.startsWith('/api/')) {
      return c.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'API endpoint not found.',
            requestId,
          },
        },
        404,
      );
    }

    const mergedAssets = c.env?.ASSETS || options?.bindingsOverride?.ASSETS;
    if (
      mergedAssets &&
      typeof mergedAssets.fetch === 'function' &&
      (c.req.method === 'GET' || c.req.method === 'HEAD')
    ) {
      const assetResponse = await mergedAssets.fetch(c.req.raw);
      if (assetResponse.status !== 404) {
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers: new Headers(assetResponse.headers),
        });
      }

      // Serve SPA index.html for client-side routes (skip missing static file extensions)
      if (!STATIC_ASSET_EXT_RE.test(path)) {
        const spaUrl = new URL('/index.html', c.req.url);
        const spaResponse = await mergedAssets.fetch(
          new Request(spaUrl.toString(), {
            method: c.req.method,
            headers: c.req.raw.headers,
          }),
        );
        return new Response(spaResponse.body, {
          status: spaResponse.ok ? 200 : spaResponse.status,
          statusText: spaResponse.statusText,
          headers: new Headers(spaResponse.headers),
        });
      }

      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: new Headers(assetResponse.headers),
      });
    }

    return c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Route not found.',
          requestId,
        },
      },
      404,
    );
  });

  return app;
}

