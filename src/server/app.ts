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
  KnowledgeDocument,
  Project,
  ResearchReport,
} from '../shared/types.ts';
import {
  executeProviderCompletion,
  ProviderExecutionError,
  streamProviderCompletion,
} from './brain/providers.ts';
import { getModelRegistry, getProviderSummary } from './brain/registry.ts';
import { BrainRoutingError, routeWithAvarestBrain } from './brain/router.ts';
import { getServerConfig, type ServerBindings } from './env.ts';
import { hashPassword, signSessionToken, verifyPassword } from './lib/crypto.ts';
import {
  appendAuditLog,
  chunkTextDocument,
  deductCreditsAtomic,
  defaultStore,
  ensureSeededSandboxAccounts,
  getUserUsageSummary,
  sanitizeUser,
  searchUserChunks,
  type WorkspaceStore,
} from './lib/store.ts';
import {
  authenticateRequest,
  rateLimit,
  requireAdmin,
  type AuthContextVariables,
} from './middleware/auth.ts';

const ALLOWED_DOC_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

export function createAvarestApiApp(options?: {
  store?: WorkspaceStore;
  bindingsOverride?: ServerBindings;
}) {
  const store = options?.store || defaultStore;
  const app = new Hono<{ Bindings: ServerBindings; Variables: AuthContextVariables }>();

  // Global request ID, config resolution, and isolation enforcement
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('store', store);
    c.header('X-Request-Id', requestId);

    const mergedBindings: ServerBindings = {
      ...(c.env || {}),
      ...(options?.bindingsOverride || {}),
    };
    const serverConfig = getServerConfig(mergedBindings);
    c.set('serverConfig', serverConfig);

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

    await next();
  });

  // Global safe error handler
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
    console.error(`[Avarest API Error] ${requestId}:`, err instanceof Error ? err.message : err);
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', requestId } },
      500,
    );
  });

  // =========================================================================
  // PUBLIC HEALTH & SYSTEM STATUS
  // =========================================================================
  app.get('/api/v1/health', (c) => {
    const config = c.get('serverConfig');
    const validation = validateEnvironmentIsolation({
      environment: config.environment,
      supabaseUrl: config.supabaseUrl,
      supabaseKeyPresent: Boolean(config.supabaseServiceRoleKey || config.supabaseAnonKey),
    });

    return c.json({
      status: validation.valid ? 'ok' : 'degraded',
      environment: config.environment,
      supabase: {
        expectedUrl: SUPABASE_PROJECTS[config.environment].url,
        configured: config.supabaseConfigured,
        isolated: validation.valid,
        authMode: config.supabaseConfigured ? 'supabase' : 'local_sandbox',
        errors: validation.errors,
      },
      providers: getProviderSummary(config),
      timestamp: new Date().toISOString(),
    });
  });

  // =========================================================================
  // AUTHENTICATION (Staging Sandbox + Supabase Ready)
  // =========================================================================
  const registerSchema = z.object({
    email: z.string().email().max(200),
    password: z.string().min(8).max(128),
    fullName: z.string().min(1).max(100),
  });

  app.post('/api/v1/auth/register', rateLimit(20, 60_000), async (c) => {
    const config = c.get('serverConfig');
    if (config.supabaseConfigured) {
      return c.json(
        {
          error: {
            code: 'USE_SUPABASE_CLIENT_AUTH',
            message: 'Supabase Auth is active. Register directly via the Supabase Auth client.',
            requestId: c.get('requestId'),
          },
        },
        400,
      );
    }
    if (config.environment === 'production') {
      return c.json(
        { error: { code: 'AUTH_NOT_CONFIGURED', message: 'Production requires Supabase Auth.', requestId: c.get('requestId') } },
        503,
      );
    }

    await ensureSeededSandboxAccounts(store);
    const body = await c.req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid input', requestId: c.get('requestId') } },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    if (store.usersByEmail.has(email)) {
      return c.json(
        { error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.', requestId: c.get('requestId') } },
        409,
      );
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(parsed.data.password);
    const newUser = {
      id,
      email,
      fullName: parsed.data.fullName.trim(),
      role: 'user' as const, // Never trust client-supplied role
      language: 'en' as const,
      experienceMode: 'beginner' as const,
      memoryConsent: false,
      activePlan: 'free' as const,
      createdAt: new Date().toISOString(),
      passwordHash,
    };

    store.users.set(id, newUser);
    store.usersByEmail.set(email, id);
    store.credits.set(id, { balance: 100, monthlyAllowance: 100 });
    store.creditLedger.unshift({
      id: crypto.randomUUID(),
      userId: id,
      delta: 100,
      balanceAfter: 100,
      reason: 'Initial free tier workspace credit grant',
      referenceId: null,
      createdAt: new Date().toISOString(),
    });
    appendAuditLog(store, {
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

    return c.json({ token, user: sanitizeUser(newUser) }, 201);
  });

  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  app.post('/api/v1/auth/login', rateLimit(30, 60_000), async (c) => {
    const config = c.get('serverConfig');
    if (config.environment === 'production' && !config.supabaseConfigured) {
      return c.json(
        { error: { code: 'AUTH_NOT_CONFIGURED', message: 'Production requires Supabase Auth.', requestId: c.get('requestId') } },
        503,
      );
    }

    await ensureSeededSandboxAccounts(store);
    const body = await c.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Valid email and password are required.', requestId: c.get('requestId') } },
        400,
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const userId = store.usersByEmail.get(email);
    const stored = userId ? store.users.get(userId) : undefined;
    if (!stored || !(await verifyPassword(parsed.data.password, stored.passwordHash))) {
      return c.json(
        { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.', requestId: c.get('requestId') } },
        401,
      );
    }

    const token = await signSessionToken(
      { sub: stored.id, email: stored.email, role: stored.role, exp: Date.now() + 24 * 60 * 60 * 1000 },
      config.authSessionSecret,
    );
    appendAuditLog(store, {
      actorId: stored.id,
      action: 'auth.login',
      resourceType: 'session',
      resourceId: stored.id,
      detail: `Signed in (${stored.role})`,
    });

    return c.json({ token, user: sanitizeUser(stored) });
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
    const body = await c.req.json().catch(() => null);
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid profile update payload.', requestId: c.get('requestId') } },
        400,
      );
    }

    const stored = store.users.get(user.id);
    if (!stored) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Profile not found.' } }, 404);
    }

    if (parsed.data.fullName !== undefined) stored.fullName = parsed.data.fullName.trim();
    if (parsed.data.language !== undefined) stored.language = parsed.data.language;
    if (parsed.data.experienceMode !== undefined) stored.experienceMode = parsed.data.experienceMode;
    if (parsed.data.memoryConsent !== undefined) stored.memoryConsent = parsed.data.memoryConsent;

    return c.json({ user: sanitizeUser(stored) });
  });

  app.get('/api/v1/models', (c) => {
    const config = c.get('serverConfig');
    return c.json({ models: getModelRegistry(config) });
  });

  // =========================================================================
  // PROJECTS CRUD (Strictly Tenant/User Isolated)
  // =========================================================================
  app.get('/api/v1/projects', (c) => {
    const user = c.get('currentUser');
    const items = Array.from(store.projects.values())
      .filter((p) => p.userId === user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ projects: items });
  });

  const projectSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    instructions: z.string().max(2000).optional(),
  });

  app.post('/api/v1/projects', async (c) => {
    const user = c.get('currentUser');
    const body = await c.req.json().catch(() => null);
    const parsed = projectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Project name is required.' } }, 400);
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() || '',
      instructions: parsed.data.instructions?.trim() || '',
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    store.projects.set(project.id, project);
    return c.json({ project }, 201);
  });

  app.patch('/api/v1/projects/:id', async (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const existing = store.projects.get(id);
    if (!existing || existing.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name === 'string' && body.name.trim()) existing.name = body.name.trim();
    if (typeof body.description === 'string') existing.description = body.description.trim();
    if (typeof body.instructions === 'string') existing.instructions = body.instructions.trim();
    if (typeof body.archived === 'boolean') existing.archived = body.archived;
    existing.updatedAt = new Date().toISOString();
    return c.json({ project: existing });
  });

  app.delete('/api/v1/projects/:id', (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const existing = store.projects.get(id);
    if (!existing || existing.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } }, 404);
    }
    store.projects.delete(id);
    return c.json({ deleted: true });
  });

  // =========================================================================
  // CONVERSATIONS CRUD (Strictly Owned by Current User)
  // =========================================================================
  app.get('/api/v1/conversations', (c) => {
    const user = c.get('currentUser');
    const q = (c.req.query('q') || '').toLowerCase().trim();
    const items = Array.from(store.conversations.values())
      .filter((conv) => conv.userId === user.id && (!q || conv.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ conversations: items });
  });

  app.post('/api/v1/conversations', async (c) => {
    const user = c.get('currentUser');
    const body = await c.req.json().catch(() => ({}));
    const now = new Date().toISOString();
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (projectId) {
      const proj = store.projects.get(projectId);
      if (!proj || proj.userId !== user.id) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Associated project not found.' } }, 404);
      }
    }
    const conv: Conversation = {
      id: crypto.randomUUID(),
      userId: user.id,
      projectId,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'New Conversation',
      routingMode: body.routingMode === 'manual' ? 'manual' : 'auto',
      preferredModel: typeof body.preferredModel === 'string' ? body.preferredModel : null,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    store.conversations.set(conv.id, conv);
    store.messages.set(conv.id, []);
    return c.json({ conversation: conv }, 201);
  });

  app.get('/api/v1/conversations/:id', (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const conv = store.conversations.get(id);
    if (!conv || conv.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
    }
    const msgs = store.messages.get(id) || [];
    return c.json({ conversation: { ...conv, messages: msgs } });
  });

  app.patch('/api/v1/conversations/:id', async (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const conv = store.conversations.get(id);
    if (!conv || conv.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.title === 'string' && body.title.trim()) conv.title = body.title.trim().slice(0, 120);
    if (typeof body.archived === 'boolean') conv.archived = body.archived;
    if (body.routingMode === 'auto' || body.routingMode === 'manual') conv.routingMode = body.routingMode;
    if (body.preferredModel === null || typeof body.preferredModel === 'string') conv.preferredModel = body.preferredModel;
    conv.updatedAt = new Date().toISOString();
    return c.json({ conversation: conv });
  });

  app.delete('/api/v1/conversations/:id', (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const conv = store.conversations.get(id);
    if (!conv || conv.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
    }
    store.conversations.delete(id);
    store.messages.delete(id);
    return c.json({ deleted: true });
  });

  // =========================================================================
  // AVAREST BRAIN CHAT EXECUTION (With Streaming & Persistence)
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

  app.post('/api/v1/chat', rateLimit(40, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const body = await c.req.json().catch(() => null);
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid chat request.', requestId: c.get('requestId') } },
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

    const acct = store.credits.get(user.id) || { balance: 0, monthlyAllowance: 100 };
    if (acct.balance < 0.5) {
      return c.json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient workspace credits.' } }, 402);
    }

    // Ensure or create conversation owned by current user
    let conv: Conversation | undefined;
    if (parsed.data.conversationId) {
      conv = store.conversations.get(parsed.data.conversationId);
      if (!conv || conv.userId !== user.id) {
        return c.json({ error: { code: 'NOT_FOUND', message: 'Conversation not found.' } }, 404);
      }
    } else {
      const now = new Date().toISOString();
      conv = {
        id: crypto.randomUUID(),
        userId: user.id,
        projectId: parsed.data.projectId || null,
        title: prompt.slice(0, 60) + (prompt.length > 60 ? '...' : ''),
        routingMode,
        preferredModel: modelId || null,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      store.conversations.set(conv.id, conv);
      store.messages.set(conv.id, []);
    }

    // Route via Avarest Brain
    const decision = routeWithAvarestBrain({
      prompt,
      config,
      mode: routingMode,
      requestedModelId: modelId,
      userPlan: user.activePlan,
      policies: store.routingPolicies,
    });

    // Build context: system instructions + project instructions + optional RAG + consent-based memories
    const systemParts: string[] = [
      'You are Avarest One, an AI workspace powered by Avarest Brain. Respond accurately, clearly, and concisely.',
    ];
    if (conv.projectId) {
      const proj = store.projects.get(conv.projectId);
      if (proj && proj.userId === user.id && proj.instructions) {
        systemParts.push(`Project instructions (${proj.name}):\n${proj.instructions}`);
      }
    }
    if (user.memoryConsent) {
      const userMems = store.memories.get(user.id) || [];
      if (userMems.length > 0) {
        systemParts.push(
          `Authorized user memory context:\n${userMems.slice(0, 10).map((m) => `- ${m.fact}`).join('\n')}`,
        );
      }
    }
    if (useKnowledge) {
      const matches = searchUserChunks(store, user.id, prompt, 3);
      if (matches.length > 0) {
        systemParts.push(
          `Retrieved workspace knowledge:\n${matches.map((m) => `[${m.fileName}#${m.chunkIndex}]: ${m.content}`).join('\n\n')}`,
        );
      }
    }

    const fullUserText = attachment
      ? `${prompt}\n\n[Attached file: ${attachment.fileName}]\n${attachment.content}`
      : prompt;

    const history = store.messages.get(conv.id) || [];
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversationId: conv.id,
      role: 'user',
      content: fullUserText,
      inputTokens: 0,
      outputTokens: 0,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    history.push(userMsg);
    store.messages.set(conv.id, history);

    const providerMessages = history.slice(-14).map((m) => ({ role: m.role, content: m.content }));
    const startedAt = Date.now();

    if (stream) {
      const encoder = new TextEncoder();
      const conversationId = conv.id;
      const bodyStream = new ReadableStream({
        async start(controller) {
          const sendEvent = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
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
              if (chunk.delta) {
                sendEvent('delta', { delta: chunk.delta });
              }
              if (chunk.done && chunk.result) {
                finalResult = chunk.result;
              }
            }

            const text = finalResult?.text || '';
            const inputTokens = finalResult?.inputTokens || 0;
            const outputTokens = finalResult?.outputTokens || 0;
            const assistantMsg: ChatMessage = {
              id: crypto.randomUUID(),
              conversationId,
              role: 'assistant',
              content: text,
              providerId: decision.selectedProvider,
              modelId: decision.selectedModel,
              taskCategory: decision.taskCategory,
              routingReason: decision.reason,
              inputTokens,
              outputTokens,
              citations: finalResult?.citations || [],
              createdAt: new Date().toISOString(),
            };
            history.push(assistantMsg);
            conv!.updatedAt = new Date().toISOString();

            const creditCost = Number(Math.max(0.1, (inputTokens + outputTokens) / 1000).toFixed(4));
            deductCreditsAtomic(store, {
              userId: user.id,
              amount: creditCost,
              reason: `Chat (${decision.selectedModel})`,
              referenceId: assistantMsg.id,
            });
            store.usageRecords.push({
              id: crypto.randomUUID(),
              userId: user.id,
              providerId: decision.selectedProvider,
              modelId: decision.selectedModel,
              feature: 'chat',
              inputTokens,
              outputTokens,
              creditsCharged: creditCost,
              createdAt: new Date().toISOString(),
            });
            store.routingLogs.unshift({
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

            sendEvent('done', { message: assistantMsg, creditsCharged: creditCost });
            controller.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Streaming failed';
            store.routingLogs.unshift({
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
            });
            sendEvent('error', { message: msg });
            controller.close();
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

    // Non-streaming execution
    const completion = await executeProviderCompletion({
      providerId: decision.selectedProvider,
      modelId: decision.selectedModel,
      messages: providerMessages,
      systemInstruction: systemParts.join('\n\n'),
      config,
    });

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      conversationId: conv.id,
      role: 'assistant',
      content: completion.text,
      providerId: decision.selectedProvider,
      modelId: decision.selectedModel,
      taskCategory: decision.taskCategory,
      routingReason: decision.reason,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      citations: completion.citations,
      createdAt: new Date().toISOString(),
    };
    history.push(assistantMsg);
    conv.updatedAt = new Date().toISOString();

    const creditCost = Number(Math.max(0.1, (completion.inputTokens + completion.outputTokens) / 1000).toFixed(4));
    deductCreditsAtomic(store, {
      userId: user.id,
      amount: creditCost,
      reason: `Chat (${decision.selectedModel})`,
      referenceId: assistantMsg.id,
    });
    store.usageRecords.push({
      id: crypto.randomUUID(),
      userId: user.id,
      providerId: decision.selectedProvider,
      modelId: decision.selectedModel,
      feature: 'chat',
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      creditsCharged: creditCost,
      createdAt: new Date().toISOString(),
    });
    store.routingLogs.unshift({
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
      conversationId: conv.id,
      decision,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      creditsCharged: creditCost,
    });
  });

  // =========================================================================
  // AVAREST BRAIN LOGS & POLICIES
  // =========================================================================
  app.get('/api/v1/brain/logs', (c) => {
    const user = c.get('currentUser');
    const logs = store.routingLogs.filter((l) => l.userId === user.id).slice(0, 50);
    return c.json({ logs });
  });

  app.get('/api/v1/brain/policies', (c) => {
    return c.json({ policies: store.routingPolicies });
  });

  // =========================================================================
  // DEEP RESEARCH
  // =========================================================================
  const researchSchema = z.object({
    query: z.string().min(3).max(2000),
  });

  app.get('/api/v1/research', (c) => {
    const user = c.get('currentUser');
    const reports = Array.from(store.researchReports.values())
      .filter((r) => r.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return c.json({ reports });
  });

  app.post('/api/v1/research', rateLimit(15, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const body = await c.req.json().catch(() => null);
    const parsed = researchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Research query must be at least 3 characters.' } }, 400);
    }

    const decision = routeWithAvarestBrain({
      prompt: parsed.data.query,
      config,
      mode: 'auto',
      explicitTask: 'research',
      userPlan: user.activePlan,
      policies: store.routingPolicies,
    });

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
      id: crypto.randomUUID(),
      userId: user.id,
      query: parsed.data.query,
      reportMarkdown: completion.text,
      citations: completion.citations,
      providerId: decision.selectedProvider,
      modelId: decision.selectedModel,
      groundingActive: completion.groundingActive,
      createdAt: new Date().toISOString(),
    };
    store.researchReports.set(report.id, report);

    const cost = Number(Math.max(0.25, (completion.inputTokens + completion.outputTokens) / 1000).toFixed(4));
    deductCreditsAtomic(store, {
      userId: user.id,
      amount: cost,
      reason: `Deep Research (${decision.selectedModel})`,
      referenceId: report.id,
    });

    return c.json({ report }, 201);
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
    const body = await c.req.json().catch(() => null);
    const parsed = coderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid AI Coder request.' } }, 400);
    }

    const decision = routeWithAvarestBrain({
      prompt: parsed.data.prompt,
      config,
      mode: 'auto',
      explicitTask: 'coding',
      userPlan: user.activePlan,
      policies: store.routingPolicies,
    });

    const composedPrompt = [
      `Task Mode: ${parsed.data.taskType.toUpperCase()}`,
      `Target Language: ${parsed.data.language}`,
      `Request: ${parsed.data.prompt}`,
      parsed.data.codeContext ? `\nCode Context:\n\`\`\`\n${parsed.data.codeContext}\n\`\`\`` : '',
    ].join('\n');

    const completion = await executeProviderCompletion({
      providerId: decision.selectedProvider,
      modelId: decision.selectedModel,
      systemInstruction:
        'You are Avarest One AI Coder. Provide clean, production-grade code, root-cause debugging, and safe patch proposals. External repository writes always require explicit human approval.',
      messages: [{ role: 'user', content: composedPrompt }],
      config,
    });

    const cost = Number(Math.max(0.2, (completion.inputTokens + completion.outputTokens) / 1000).toFixed(4));
    deductCreditsAtomic(store, {
      userId: user.id,
      amount: cost,
      reason: `AI Coder: ${parsed.data.taskType}`,
    });

    return c.json({
      output: completion.text,
      decision,
      requiresHumanApprovalForExternalWrite: true,
      tokens: { input: completion.inputTokens, output: completion.outputTokens },
    });
  });

  // =========================================================================
  // AI AGENTS & HUMAN APPROVAL CHECKPOINTS
  // =========================================================================
  app.get('/api/v1/agents', (c) => {
    const user = c.get('currentUser');
    const agents = Array.from(store.agents.values()).filter((a) => a.userId === user.id);
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
    store.agents.set(agent.id, agent);
    return c.json({ agent }, 201);
  });

  app.get('/api/v1/agents/runs', (c) => {
    const user = c.get('currentUser');
    const runs = Array.from(store.agentRuns.values())
      .filter((r) => r.userId === user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => {
        const pendingApproval = Array.from(store.agentApprovals.values()).find(
          (ap) => ap.runId === run.id && ap.decision === 'pending',
        );
        return { ...run, pendingApproval: pendingApproval || null };
      });
    return c.json({ runs });
  });

  app.post('/api/v1/agents/:id/run', rateLimit(15, 60_000), async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const agentId = c.req.param('id') || '';
    const agent = store.agents.get(agentId);
    if (!agent || agent.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Agent not found.' } }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const inputTask = typeof body.inputTask === 'string' ? body.inputTask.trim() : '';
    if (!inputTask) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'inputTask is required.' } }, 400);
    }

    const now = new Date().toISOString();
    const run: AgentRun = {
      id: crypto.randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      userId: user.id,
      inputTask,
      status: agent.requireApproval ? 'awaiting_approval' : 'running',
      outputSummary: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };

    if (agent.requireApproval) {
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
      store.agentApprovals.set(approval.id, approval);
      store.agentRuns.set(run.id, run);
      return c.json({ run: { ...run, pendingApproval: approval } }, 201);
    }

    // Execute immediately if human approval checkpoint is disabled on agent
    try {
      const decision = routeWithAvarestBrain({
        prompt: inputTask,
        config,
        mode: 'auto',
        userPlan: user.activePlan,
      });
      const res = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        systemInstruction: `Agent "${agent.name}" (${agent.category}). Instructions: ${agent.instructions}`,
        messages: [{ role: 'user', content: inputTask }],
        config,
      });
      run.status = 'completed';
      run.outputSummary = res.text;
    } catch (err) {
      run.status = 'failed';
      run.errorMessage = err instanceof Error ? err.message : 'Agent execution failed';
    }
    run.updatedAt = new Date().toISOString();
    store.agentRuns.set(run.id, run);
    return c.json({ run }, 201);
  });

  app.post('/api/v1/agents/approvals/:id/decide', async (c) => {
    const user = c.get('currentUser');
    const config = c.get('serverConfig');
    const approval = store.agentApprovals.get(c.req.param('id'));
    if (!approval || approval.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Approval checkpoint not found.' } }, 404);
    }
    if (approval.decision !== 'pending') {
      return c.json({ error: { code: 'ALREADY_DECIDED', message: 'This approval was already resolved.' } }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Decision must be "approved" or "rejected".' } }, 400);
    }

    approval.decision = body.decision;
    approval.decidedAt = new Date().toISOString();

    const run = store.agentRuns.get(approval.runId);
    if (!run) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Associated run not found.' } }, 404);
    }

    if (body.decision === 'rejected') {
      run.status = 'canceled';
      run.outputSummary = 'Execution canceled at human approval checkpoint.';
      run.updatedAt = new Date().toISOString();
      return c.json({ approval, run });
    }

    const agent = store.agents.get(run.agentId);
    try {
      const decision = routeWithAvarestBrain({
        prompt: run.inputTask,
        config,
        mode: 'auto',
        userPlan: user.activePlan,
      });
      const res = await executeProviderCompletion({
        providerId: decision.selectedProvider,
        modelId: decision.selectedModel,
        systemInstruction: `Agent "${agent?.name || run.agentName}". Instructions: ${agent?.instructions || ''}`,
        messages: [{ role: 'user', content: run.inputTask }],
        config,
      });
      run.status = 'completed';
      run.outputSummary = res.text;
    } catch (err) {
      run.status = 'failed';
      run.errorMessage = err instanceof Error ? err.message : 'Agent execution failed';
    }
    run.updatedAt = new Date().toISOString();
    return c.json({ approval, run });
  });

  app.post('/api/v1/agents/runs/:id/cancel', (c) => {
    const user = c.get('currentUser');
    const run = store.agentRuns.get(c.req.param('id'));
    if (!run || run.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Run not found.' } }, 404);
    }
    run.status = 'canceled';
    run.updatedAt = new Date().toISOString();
    return c.json({ run });
  });

  // =========================================================================
  // KNOWLEDGE & CONSENT-BASED MEMORY
  // =========================================================================
  app.get('/api/v1/knowledge/documents', (c) => {
    const user = c.get('currentUser');
    const documents = Array.from(store.knowledgeDocs.values()).filter((d) => d.userId === user.id);
    return c.json({ documents });
  });

  const docUploadSchema = z.object({
    fileName: z.string().min(1).max(180),
    mimeType: z.string().max(100),
    content: z.string().min(1).max(1_000_000),
  });

  app.post('/api/v1/knowledge/documents', async (c) => {
    const user = c.get('currentUser');
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
    const docId = crypto.randomUUID();
    const doc: KnowledgeDocument = {
      id: docId,
      userId: user.id,
      fileName: parsed.data.fileName.trim(),
      mimeType: parsed.data.mimeType,
      byteSize: new TextEncoder().encode(parsed.data.content).length,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
    };
    store.knowledgeDocs.set(docId, doc);
    chunks.forEach((content, idx) => {
      store.knowledgeChunks.push({
        id: crypto.randomUUID(),
        documentId: docId,
        userId: user.id,
        fileName: doc.fileName,
        chunkIndex: idx,
        content,
      });
    });

    return c.json({ document: doc }, 201);
  });

  app.delete('/api/v1/knowledge/documents/:id', (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const doc = store.knowledgeDocs.get(id);
    if (!doc || doc.userId !== user.id) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Document not found.' } }, 404);
    }
    store.knowledgeDocs.delete(id);
    store.knowledgeChunks = store.knowledgeChunks.filter((ch) => ch.documentId !== id);
    return c.json({ deleted: true });
  });

  app.post('/api/v1/knowledge/search', async (c) => {
    const user = c.get('currentUser');
    const body = await c.req.json().catch(() => ({}));
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const matches = searchUserChunks(store, user.id, query, 8);
    return c.json({ matches });
  });

  app.get('/api/v1/memories', (c) => {
    const user = c.get('currentUser');
    return c.json({
      consentEnabled: user.memoryConsent,
      memories: store.memories.get(user.id) || [],
    });
  });

  app.post('/api/v1/memories', async (c) => {
    const user = c.get('currentUser');
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
    const existing = store.memories.get(user.id) || [];
    const memory = {
      id: crypto.randomUUID(),
      userId: user.id,
      fact,
      source: 'user' as const,
      createdAt: new Date().toISOString(),
    };
    existing.unshift(memory);
    store.memories.set(user.id, existing);
    return c.json({ memory }, 201);
  });

  app.delete('/api/v1/memories/:id', (c) => {
    const user = c.get('currentUser');
    const id = c.req.param('id');
    const existing = store.memories.get(user.id) || [];
    store.memories.set(
      user.id,
      existing.filter((m) => m.id !== id),
    );
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
  app.get('/api/v1/usage', (c) => {
    const user = c.get('currentUser');
    return c.json({ usage: getUserUsageSummary(store, user.id) });
  });

  // =========================================================================
  // PROTECTED ADMIN CONSOLE (Strict Server-Side RBAC)
  // =========================================================================
  app.use('/api/v1/admin/*', authenticateRequest, requireAdmin);

  app.get('/api/v1/admin/overview', (c) => {
    const config = c.get('serverConfig');
    return c.json({
      environment: config.environment,
      totalUsers: store.users.size,
      totalConversations: store.conversations.size,
      totalProjects: store.projects.size,
      totalAgents: store.agents.size,
      totalRoutingLogs: store.routingLogs.length,
      totalUsageRecords: store.usageRecords.length,
      providers: getProviderSummary(config),
    });
  });

  app.get('/api/v1/admin/users', (c) => {
    const users = Array.from(store.users.values()).map((u) => {
      const acct = store.credits.get(u.id);
      return {
        ...sanitizeUser(u),
        creditBalance: acct?.balance ?? 0,
      };
    });
    return c.json({ users });
  });

  app.patch('/api/v1/admin/users/:id/role', async (c) => {
    const actor = c.get('currentUser');
    const target = store.users.get(c.req.param('id'));
    if (!target) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'User not found.' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (body.role !== 'user' && body.role !== 'admin' && body.role !== 'super_admin') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid role.' } }, 400);
    }
    target.role = body.role;
    appendAuditLog(store, {
      actorId: actor.id,
      action: 'admin.user.role_updated',
      resourceType: 'profile',
      resourceId: target.id,
      detail: `Role changed to ${body.role} for ${target.email}`,
    });
    return c.json({ user: sanitizeUser(target) });
  });

  app.get('/api/v1/admin/audit-logs', (c) => {
    return c.json({ auditLogs: store.auditLogs.slice(0, 100) });
  });

  app.get('/api/v1/admin/flags', (c) => {
    return c.json({ flags: Array.from(store.featureFlags.values()) });
  });

  app.patch('/api/v1/admin/flags/:key', async (c) => {
    const actor = c.get('currentUser');
    const key = c.req.param('key');
    const flag = store.featureFlags.get(key);
    if (!flag) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Feature flag not found.' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'enabled boolean is required.' } }, 400);
    }
    flag.enabled = body.enabled;
    appendAuditLog(store, {
      actorId: actor.id,
      action: 'admin.flag.updated',
      resourceType: 'feature_flag',
      resourceId: key,
      detail: `Set ${key} = ${body.enabled}`,
    });
    return c.json({ flag });
  });

  app.patch('/api/v1/admin/policies/:id', async (c) => {
    const actor = c.get('currentUser');
    const id = c.req.param('id');
    const policy = store.routingPolicies.find((p) => p.id === id);
    if (!policy) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Routing policy not found.' } }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.active === 'boolean') policy.active = body.active;
    if (typeof body.preferredModelId === 'string') policy.preferredModelId = body.preferredModelId;
    if (typeof body.fallbackModelId === 'string') policy.fallbackModelId = body.fallbackModelId;
    appendAuditLog(store, {
      actorId: actor.id,
      action: 'admin.policy.updated',
      resourceType: 'routing_policy',
      resourceId: id,
      detail: `Updated policy ${policy.name}`,
    });
    return c.json({ policy });
  });

  return app;
}
