import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAvarestApiApp } from '../src/server/app.ts';
import { classifyPromptTask } from '../src/server/brain/classifier.ts';
import {
  parseSseLines,
  sanitizeProviderErrorMessage,
  streamProviderCompletion,
} from '../src/server/brain/providers.ts';
import { ACTIVE_PROVIDER_IDS, getModelRegistry, getProviderSummary } from '../src/server/brain/registry.ts';
import { BrainRoutingError, routeWithAvarestBrain } from '../src/server/brain/router.ts';
import { getServerConfig } from '../src/server/env.ts';
import { createStore, deductCreditsAtomic } from '../src/server/lib/store.ts';
import { KVRateLimitAdapter } from '../src/server/middleware/rateLimit.ts';
import { SUPABASE_PROJECTS, validateEnvironmentIsolation } from '../src/shared/env.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Supabase Environment Isolation & Production Guardrails', () => {
  it('validates matching staging and production URLs', () => {
    const stagingOk = validateEnvironmentIsolation({
      environment: 'staging',
      supabaseUrl: SUPABASE_PROJECTS.staging.url,
      supabaseKeyPresent: true,
    });
    expect(stagingOk.valid).toBe(true);
    expect(stagingOk.supabaseConfigured).toBe(true);

    const prodOk = validateEnvironmentIsolation({
      environment: 'production',
      supabaseUrl: SUPABASE_PROJECTS.production.url,
      supabaseKeyPresent: true,
    });
    expect(prodOk.valid).toBe(true);
    expect(prodOk.supabaseConfigured).toBe(true);
  });

  it('rejects cross-environment Supabase URLs', () => {
    const cross1 = validateEnvironmentIsolation({
      environment: 'staging',
      supabaseUrl: SUPABASE_PROJECTS.production.url,
      supabaseKeyPresent: true,
    });
    expect(cross1.valid).toBe(false);
    expect(cross1.errors[0]).toContain('ISOLATION VIOLATION');

    const cross2 = validateEnvironmentIsolation({
      environment: 'production',
      supabaseUrl: SUPABASE_PROJECTS.staging.url,
      supabaseKeyPresent: true,
    });
    expect(cross2.valid).toBe(false);
  });

  it('blocks API requests with 500 when staging points to production Supabase', async () => {
    const app = createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
      },
    });
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('ENVIRONMENT_ISOLATION_ERROR');
  });

  it('strictly refuses silent in-memory fallback in production when Supabase is unconfigured', async () => {
    const app = createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'production',
        AUTH_SESSION_SECRET: 'prod-test-secret-0123456789abcdef',
      },
    });

    const health = await app.request('/api/v1/health');
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as {
      status: string;
      storageMode: string;
      supabase: { dbReachable: boolean; configured: boolean };
    };
    expect(healthJson.status).toBe('degraded');
    expect(healthJson.storageMode).toBe('unconfigured_blocked');
    expect(healthJson.supabase.configured).toBe(false);
    expect(healthJson.supabase.dbReachable).toBe(false);

    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'prod@avarestai.com', password: 'Password#1234', fullName: 'Prod' }),
    });
    expect(reg.status).toBe(503);

    const login = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'prod@avarestai.com', password: 'Password#1234' }),
    });
    expect(login.status).toBe(503);

    const projects = await app.request('/api/v1/projects', {
      headers: { Authorization: 'Bearer fake-token' },
    });
    expect(projects.status).toBe(503);
  });
});

describe('Four-Provider Avarest Brain Registry, Classification & Routing', () => {
  it('exposes ONLY the 4 active initial-release providers (OpenAI, Gemini, Anthropic, DeepSeek)', () => {
    expect([...ACTIVE_PROVIDER_IDS].sort()).toEqual(['anthropic', 'deepseek', 'gemini', 'openai']);

    const config = getServerConfig({
      AVAREST_ENVIRONMENT: 'staging',
      OPENAI_API_KEY: 'oa-test',
      GEMINI_API_KEY: 'gm-test',
      ANTHROPIC_API_KEY: 'an-test',
      DEEPSEEK_API_KEY: 'ds-test',
      XAI_API_KEY: 'xai-should-not-appear',
      LLAMA_API_KEY: 'llama-should-not-appear',
    });

    const summary = getProviderSummary(config);
    expect(summary.map((p) => p.id)).toEqual(['openai', 'gemini', 'anthropic', 'deepseek']);
    expect(summary).toHaveLength(4);

    const registry = getModelRegistry(config);
    expect(registry.some((m) => m.providerId === 'xai' || m.providerId === 'llama')).toBe(false);
    expect(registry.every((m) => ['openai', 'gemini', 'anthropic', 'deepseek'].includes(m.providerId))).toBe(true);
  });

  it('classifies coding, research, and general prompts accurately', () => {
    expect(classifyPromptTask('Debug this TypeScript async function error').category).toBe('coding');
    expect(classifyPromptTask('Compare the latest market research evidence and citations').category).toBe('research');
    expect(classifyPromptTask('Hello there, how can I organize my week?').category).toBe('general_chat');
  });

  it('throws NO_CONFIGURED_PROVIDERS when zero active keys exist', () => {
    const config = getServerConfig({ AVAREST_ENVIRONMENT: 'staging', AUTH_SESSION_SECRET: 'test-secret-123' });
    config.providers.gemini = undefined;
    config.providers.openai = undefined;
    config.providers.anthropic = undefined;
    config.providers.deepseek = undefined;

    expect(() =>
      routeWithAvarestBrain({
        prompt: 'Write a function',
        config,
        mode: 'auto',
      }),
    ).toThrowError(BrainRoutingError);
  });

  it('routes coding via fallback when Anthropic is unconfigured but Gemini is configured', () => {
    const config = getServerConfig({
      AVAREST_ENVIRONMENT: 'staging',
      AUTH_SESSION_SECRET: 'test-secret-123',
      GEMINI_API_KEY: 'test-gemini-key',
    });

    const decision = routeWithAvarestBrain({
      prompt: 'Debug this React TypeScript component',
      config,
      mode: 'auto',
      userPlan: 'pro',
    });

    expect(decision.selectedProvider).toBe('gemini');
    expect(decision.selectedModel).toBe('gemini-4-hydrogen');
    expect(decision.fallbackUsed).toBe(true);
  });

  it('rejects manual selection of unconfigured or disabled models (e.g., xai/llama)', () => {
    const config = getServerConfig({
      AVAREST_ENVIRONMENT: 'staging',
      AUTH_SESSION_SECRET: 'test-secret-123',
      GEMINI_API_KEY: 'test-gemini-key',
    });

    expect(() =>
      routeWithAvarestBrain({
        prompt: 'Hello',
        config,
        mode: 'manual',
        requestedModelId: 'gpt-4o',
      }),
    ).toThrowError(BrainRoutingError);

    expect(() =>
      routeWithAvarestBrain({
        prompt: 'Hello',
        config,
        mode: 'manual',
        requestedModelId: 'grok-2-latest',
      }),
    ).toThrowError(BrainRoutingError);
  });
});

describe('Native SSE Streaming, Usage Extraction & Error Sanitization', () => {
  function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  it('parses chunked SSE frames split across buffer boundaries', async () => {
    const stream = makeSseStream([
      'event: message\ndata: {"a":',
      '1}\n\ndata: [DONE]\n\n',
    ]);
    const frames: Array<{ event?: string; data: string }> = [];
    for await (const frame of parseSseLines(stream)) {
      frames.push(frame);
    }
    expect(frames).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: undefined, data: '[DONE]' },
    ]);
  });

  it('streams OpenAI/DeepSeek SSE with real token counts (usageIsEstimated: false)', async () => {
    const mockStream = makeSseStream([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(mockStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
    );

    const config = getServerConfig({ AVAREST_ENVIRONMENT: 'staging', OPENAI_API_KEY: 'sk-test-secret' });
    const deltas: string[] = [];
    let finalUsageEstimated: boolean | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const item of streamProviderCompletion({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say hi' }],
      config,
    })) {
      if (item.delta) deltas.push(item.delta);
      if (item.done && item.result) {
        finalUsageEstimated = item.result.usageIsEstimated;
        inputTokens = item.result.inputTokens;
        outputTokens = item.result.outputTokens;
      }
    }

    expect(deltas.join('')).toBe('Hello world');
    expect(finalUsageEstimated).toBe(false);
    expect(inputTokens).toBe(12);
    expect(outputTokens).toBe(5);
  });

  it('streams Anthropic SSE and marks estimated usage when usage block is absent', async () => {
    const mockStream = makeSseStream([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":19}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Claude stream"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(mockStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
    );

    const config = getServerConfig({ AVAREST_ENVIRONMENT: 'staging', ANTHROPIC_API_KEY: 'sk-ant-test' });
    let text = '';
    let usageIsEstimated = false;

    for await (const item of streamProviderCompletion({
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'Test Anthropic' }],
      config,
    })) {
      if (item.delta) text += item.delta;
      if (item.done && item.result) usageIsEstimated = item.result.usageIsEstimated;
    }

    expect(text).toBe('Claude stream');
    expect(usageIsEstimated).toBe(true);
  });

  it('sanitizes upstream provider error payloads without leaking raw keys', () => {
    const sanitized = sanitizeProviderErrorMessage(
      'openai',
      401,
      'Incorrect API key provided: sk-proj-SUPER_SECRET_KEY_12345',
    );
    expect(sanitized).not.toContain('sk-proj');
    expect(sanitized).toContain('OpenAI authentication failed');
  });
});

describe('Auth Hardening, Admin Bootstrap, RBAC, Credits & Rate Limiting', () => {
  const createTestApp = (extraBindings: Record<string, unknown> = {}) =>
    createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
        ADMIN_BOOTSTRAP_SECRET: 'bootstrap-secret-vitest-12345678',
        ...extraBindings,
      },
    });

  it('rejects removed hardcoded demo credentials (no backdoor accounts)', async () => {
    const app = createTestApp();

    const adminAttempt = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@avarestai.com',
        password: 'AvarestAdmin#2026',
      }),
    });
    expect(adminAttempt.status).toBe(401);

    const userAttempt = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@avarestai.com',
        password: 'AvarestUser#2026',
      }),
    });
    expect(userAttempt.status).toBe(401);
  });

  it('enforces explicit secret-gated first-admin bootstrap and locks afterward', async () => {
    const app = createTestApp();

    // Unauthenticated rejected
    const unauth = await app.request('/api/v1/projects');
    expect(unauth.status).toBe(401);

    // Bootstrap without valid secret fails with 403
    const badBootstrap = await app.request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-bootstrap-secret': 'wrong-secret',
      },
      body: JSON.stringify({
        email: 'founder@avarestai.com',
        password: 'StrongPassword#2026',
        fullName: 'Founder Admin',
      }),
    });
    expect(badBootstrap.status).toBe(403);

    // Standard user registration creates role='user' and cannot access Admin Console
    const regRes = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@avarestai.com',
        password: 'Password#1234',
        fullName: 'Alice',
      }),
    });
    expect(regRes.status).toBe(201);
    const regJson = (await regRes.json()) as { token: string; user: { role: string } };
    expect(regJson.user.role).toBe('user');

    const forbidden = await app.request('/api/v1/admin/overview', {
      headers: { Authorization: `Bearer ${regJson.token}` },
    });
    expect(forbidden.status).toBe(403);

    // Valid first-admin bootstrap succeeds
    const bootstrapOk = await app.request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-bootstrap-secret': 'bootstrap-secret-vitest-12345678',
      },
      body: JSON.stringify({
        email: 'founder@avarestai.com',
        password: 'StrongPassword#2026',
        fullName: 'Founder Admin',
      }),
    });
    expect(bootstrapOk.status).toBe(201);

    // Second bootstrap attempt is permanently locked (409)
    const bootstrapLocked = await app.request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-bootstrap-secret': 'bootstrap-secret-vitest-12345678',
      },
      body: JSON.stringify({
        email: 'second@avarestai.com',
        password: 'StrongPassword#2026',
      }),
    });
    expect(bootstrapLocked.status).toBe(409);

    // Bootstrapped admin signs in and accesses Admin Console + Provider Health
    const adminLogin = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'founder@avarestai.com',
        password: 'StrongPassword#2026',
      }),
    });
    expect(adminLogin.status).toBe(200);
    const adminJson = (await adminLogin.json()) as { token: string };

    const adminOverview = await app.request('/api/v1/admin/overview', {
      headers: { Authorization: `Bearer ${adminJson.token}` },
    });
    expect(adminOverview.status).toBe(200);

    const providerHealth = await app.request('/api/v1/admin/provider-health', {
      headers: { Authorization: `Bearer ${adminJson.token}` },
    });
    expect(providerHealth.status).toBe(200);
  });

  it('enforces strict user isolation across projects, knowledge chunks, and memories', async () => {
    const app = createTestApp();

    const regA = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'usera@avarestai.com', password: 'Password#1234', fullName: 'User A' }),
    });
    const tokenA = ((await regA.json()) as { token: string }).token;

    const regB = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'userb@avarestai.com', password: 'Password#1234', fullName: 'User B' }),
    });
    const tokenB = ((await regB.json()) as { token: string }).token;

    const projRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: 'Alpha Secret Project' }),
    });
    expect(projRes.status).toBe(201);
    const projId = ((await projRes.json()) as { project: { id: string } }).project.id;

    const docRes = await app.request('/api/v1/knowledge/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        fileName: 'secret.txt',
        mimeType: 'text/plain',
        content: 'Avarest confidential project alpha blueprint',
      }),
    });
    expect(docRes.status).toBe(201);

    const delByB = await app.request(`/api/v1/projects/${projId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(delByB.status).toBe(404);

    const searchByB = await app.request('/api/v1/knowledge/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ query: 'blueprint' }),
    });
    const searchJson = (await searchByB.json()) as { matches: unknown[] };
    expect(searchJson.matches).toHaveLength(0);

    const memBlocked = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ fact: 'Prefer TypeScript strict mode' }),
    });
    expect(memBlocked.status).toBe(403);
  });

  it('enforces human approval checkpoints on agents and honest integration status', async () => {
    const app = createTestApp();
    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'agentuser@avarestai.com', password: 'Password#1234', fullName: 'Agent User' }),
    });
    const token = ((await reg.json()) as { token: string }).token;

    const agentRes = await app.request('/api/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Audit Agent',
        category: 'research',
        instructions: 'Review security logs safely',
        requireApproval: true,
      }),
    });
    expect(agentRes.status).toBe(201);
    const agentId = ((await agentRes.json()) as { agent: { id: string } }).agent.id;

    const runRes = await app.request(`/api/v1/agents/${agentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputTask: 'Summarize Q4 security readiness' }),
    });
    expect(runRes.status).toBe(201);
    const runJson = (await runRes.json()) as {
      run: { status: string; pendingApproval: { id: string } };
    };
    expect(runJson.run.status).toBe('awaiting_approval');

    const rejectRes = await app.request(`/api/v1/agents/approvals/${runJson.run.pendingApproval.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: 'rejected' }),
    });
    expect(rejectRes.status).toBe(200);
    const rejectJson = (await rejectRes.json()) as { run: { status: string } };
    expect(rejectJson.run.status).toBe('canceled');

    const intRes = await app.request('/api/v1/integrations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(intRes.status).toBe(200);
    const intJson = (await intRes.json()) as { integrations: Array<{ status: string }> };
    expect(intJson.integrations.every((i) => i.status !== 'connected')).toBe(true);
  });

  it('prevents credit overdraft and enforces referenceId idempotency', () => {
    const store = createStore();
    store.credits.set('u1', { balance: 10, monthlyAllowance: 100 });

    const afterFirst = deductCreditsAtomic(store, {
      userId: 'u1',
      amount: 3,
      reason: 'Chat',
      referenceId: 'msg-idemp-1',
    });
    expect(afterFirst).toBe(7);

    // Repeating with same referenceId must not deduct twice
    const afterDuplicate = deductCreditsAtomic(store, {
      userId: 'u1',
      amount: 3,
      reason: 'Chat',
      referenceId: 'msg-idemp-1',
    });
    expect(afterDuplicate).toBe(7);

    expect(() =>
      deductCreditsAtomic(store, { userId: 'u1', amount: 8, reason: 'Chat', referenceId: 'msg-overdraft' }),
    ).toThrow('INSUFFICIENT_CREDITS');
  });

  it('enforces distributed KV rate limiting and emits standard headers', async () => {
    const kvMap = new Map<string, string>();
    const adapter = new KVRateLimitAdapter({
      async get(key) {
        return kvMap.get(key) ?? null;
      },
      async put(key, value) {
        kvMap.set(key, value);
      },
    });

    const r1 = await adapter.consume('user1:/api/v1/chat', 2, 60_000);
    const r2 = await adapter.consume('user1:/api/v1/chat', 2, 60_000);
    const r3 = await adapter.consume('user1:/api/v1/chat', 2, 60_000);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
    expect(r3.allowed).toBe(false);
  });
});

describe('Security Migration SQL, Brand Assets, Theme & Mandatory Footer Checks', () => {
  it('verifies corrective SQL migration 0002_security_hardening.sql covers required hardening', () => {
    const sqlPath = path.resolve(process.cwd(), 'supabase/migrations/0002_security_hardening.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');

    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.deduct_credits');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.deduct_credits(UUID, NUMERIC, TEXT, TEXT) TO service_role');
    expect(sql).toContain('protect_profile_sensitive_columns');
    expect(sql).toContain('organizations_select');
    expect(sql).toContain('org_members_select');
    expect(sql).toContain('idx_credit_ledger_user_ref_unique');
    expect(sql).toContain("'knowledge-documents'");
    expect(sql).toContain('DROP POLICY IF EXISTS');
  });

  it('verifies brand assets, favicons, theme script, and mandatory Avarest Soft footer exist', () => {
    const publicDir = path.resolve(process.cwd(), 'public');
    for (const file of [
      'favicon.ico',
      'favicon.svg',
      'favicon-16x16.png',
      'favicon-32x32.png',
      'favicon-48x48.png',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'logo-light.svg',
      'logo-dark.svg',
      'logo-compact.svg',
      'manifest.webmanifest',
    ]) {
      const fullPath = path.join(publicDir, file);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.statSync(fullPath).size).toBeGreaterThan(100);
    }

    const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
    expect(indexHtml).toContain('avarest_one_theme');
    expect(indexHtml).toContain('favicon.ico');
    expect(indexHtml).toContain('manifest.webmanifest');

    const appTsx = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
    expect(appTsx).toContain('Design &amp; Developed by');
    expect(appTsx).toContain('https://avarestsoft.com/');
    expect(appTsx).toContain('Avarest Soft');
  });
});
