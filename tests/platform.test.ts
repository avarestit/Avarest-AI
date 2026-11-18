import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAvarestApiApp } from '../src/server/app.ts';
import { classifyPromptTask } from '../src/server/brain/classifier.ts';
import {
  executeProviderCompletion,
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
import workerApp from '../src/worker.ts';

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

describe('Phase 02 Security, Edge Headers, Validation & Concurrency Regression Suite', () => {
  it('ignores placeholder API keys and detects VITE_SUPABASE_URL vs SUPABASE_URL cross-mismatches', () => {
    const placeholderCfg = getServerConfig({
      AVAREST_ENVIRONMENT: 'staging',
      GEMINI_API_KEY: 'MY_GEMINI_API_KEY',
      OPENAI_API_KEY: 'YOUR_OPENAI_KEY',
      ANTHROPIC_API_KEY: '<REPLACE_ME>',
      ADMIN_BOOTSTRAP_SECRET: 'CHANGE_ME_BOOTSTRAP_SECRET',
    });

    expect(placeholderCfg.providers.gemini).toBeUndefined();
    expect(placeholderCfg.providers.openai).toBeUndefined();
    expect(placeholderCfg.providers.anthropic).toBeUndefined();
    expect(placeholderCfg.adminBootstrapSecret).toBeUndefined();
    expect(placeholderCfg.configValidation.warnings.length).toBeGreaterThanOrEqual(3);

    const mismatchCfg = getServerConfig({
      AVAREST_ENVIRONMENT: 'staging',
      VITE_ENVIRONMENT: 'staging',
      SUPABASE_URL: SUPABASE_PROJECTS.staging.url,
      VITE_SUPABASE_URL: SUPABASE_PROJECTS.production.url,
    });
    expect(mismatchCfg.isolationErrors.length).toBeGreaterThan(0);
    expect(mismatchCfg.supabaseConfigured).toBe(false);
  });

  it('sets security headers, enforces CORS allowlist, and fails closed on missing bootstrap secret (503) & brute-force (429)', async () => {
    const appNoBootstrap = createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
      },
    });

    // CORS allowlist & security headers
    const allowedPreflight = await appNoBootstrap.request('/api/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://staging.avarestai.com' },
    });
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.avarestai.com');
    expect(allowedPreflight.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(allowedPreflight.headers.get('X-Frame-Options')).toBe('DENY');

    const blockedPreflight = await appNoBootstrap.request('/api/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil-attacker.example' },
    });
    expect(blockedPreflight.status).toBe(403);
    expect(blockedPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();

    // Missing ADMIN_BOOTSTRAP_SECRET fails closed with 503
    const missingSecretRes = await appNoBootstrap.request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@avarestai.com', password: 'StrongPassword#2026' }),
    });
    expect(missingSecretRes.status).toBe(503);
    expect(missingSecretRes.headers.get('Cache-Control')).toBe('no-store');

    // Brute-force bootstrap attempts hit rate limit (429) after 5 tries
    const appWithBootstrap = createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
        ADMIN_BOOTSTRAP_SECRET: 'valid-bootstrap-secret-1234567890',
      },
    });
    for (let i = 0; i < 5; i++) {
      const attempt = await appWithBootstrap.request('/api/v1/admin/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-bootstrap-secret': 'bad-guess',
          'x-forwarded-for': '203.0.113.77',
        },
        body: JSON.stringify({ email: 'admin@avarestai.com', password: 'StrongPassword#2026' }),
      });
      expect(attempt.status).toBe(403);
    }
    const rateLimited = await appWithBootstrap.request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-bootstrap-secret': 'bad-guess',
        'x-forwarded-for': '203.0.113.77',
      },
      body: JSON.stringify({ email: 'admin@avarestai.com', password: 'StrongPassword#2026' }),
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get('Retry-After')).toBeTruthy();
  });

  it('enforces Zod PATCH validation and pre-flight 402 credit checks on research and coder', async () => {
    const store = createStore();
    const app = createAvarestApiApp({
      store,
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
        GEMINI_API_KEY: 'test-gemini-key-active',
      },
    });

    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'patchtest@avarestai.com', password: 'Password#1234', fullName: 'Patch Test' }),
    });
    const { token, user } = (await reg.json()) as { token: string; user: { id: string } };

    // Create project & test invalid PATCH payload rejection
    const projRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Valid Project' }),
    });
    const projId = ((await projRes.json()) as { project: { id: string } }).project.id;

    const badPatch = await app.request(`/api/v1/projects/${projId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ archived: 'not-a-boolean' }),
    });
    expect(badPatch.status).toBe(400);

    // Exhaust credits below threshold & verify 402 pre-flight on /research and /coder
    store.credits.set(user.id, { balance: 0.05, monthlyAllowance: 100 });
    const researchBlocked = await app.request('/api/v1/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'Evaluate AI security architecture' }),
    });
    expect(researchBlocked.status).toBe(402);

    const coderBlocked = await app.request('/api/v1/coder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskType: 'review', language: 'TypeScript', prompt: 'Audit auth module' }),
    });
    expect(coderBlocked.status).toBe(402);
  });

  it('prevents concurrent double-deduction overdraft and retries transient 502 once', async () => {
    const store = createStore();
    store.credits.set('race-user', { balance: 5, monthlyAllowance: 100 });

    const results = await Promise.allSettled([
      Promise.resolve().then(() => deductCreditsAtomic(store, { userId: 'race-user', amount: 4, reason: 'Op 1', referenceId: 'r1' })),
      Promise.resolve().then(() => deductCreditsAtomic(store, { userId: 'race-user', amount: 4, reason: 'Op 2', referenceId: 'r2' })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(store.credits.get('race-user')?.balance).toBe(1);

    // Transient 502 retry test on OpenAI adapter
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('Bad gateway', { status: 502 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Recovered after retry' } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const cfg = getServerConfig({ AVAREST_ENVIRONMENT: 'staging', OPENAI_API_KEY: 'sk-live-test-key' });
    const completion = await executeProviderCompletion({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
      config: cfg,
    });
    expect(calls).toBe(2);
    expect(completion.text).toBe('Recovered after retry');
    expect(completion.usageIsEstimated).toBe(false);
  });

  it('executes Cloudflare Workers entrypoint with RATE_LIMIT_KV binding and scopes SQL migration policies', async () => {
    const kvStore = new Map<string, string>();
    const env = {
      AVAREST_ENVIRONMENT: 'staging',
      RATE_LIMIT_KV: {
        async get(key: string) {
          return kvStore.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kvStore.set(key, value);
        },
      },
    };

    const res = await workerApp.fetch(new Request('https://staging.avarestai.com/api/v1/health'), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rateLimitMode: string; environment: string };
    expect(json.environment).toBe('staging');
    expect(json.rateLimitMode).toBe('distributed_kv');

    const sqlPath = path.resolve(process.cwd(), 'supabase/migrations/0002_security_hardening.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    expect(sql).toContain('usage_is_estimated');
    expect(sql).toContain('credit_accounts_owner_select ON public.credit_accounts FOR SELECT TO authenticated');
  });
});

describe('Cloudflare Workers Global Scope & Production Secret Guardrails', () => {
  it('does not call crypto.randomUUID() at global scope when importing env.ts or worker.ts', async () => {
    vi.resetModules();
    const randomUuidSpy = vi.spyOn(crypto, 'randomUUID');

    const envMod = await import('../src/server/env.ts');
    const workerMod = await import('../src/worker.ts');

    expect(workerMod.default).toBeDefined();
    expect(typeof workerMod.default.fetch).toBe('function');
    expect(randomUuidSpy).not.toHaveBeenCalled();

    // Calling getServerConfig in staging with an explicit secret also avoids ephemeral UUID generation
    const explicitConfig = envMod.getServerConfig({
      AVAREST_ENVIRONMENT: 'staging',
      AUTH_SESSION_SECRET: 'explicit-staging-secret-1234567890',
    });
    expect(explicitConfig.authSessionSecret).toBe('explicit-staging-secret-1234567890');
    expect(randomUuidSpy).not.toHaveBeenCalled();
  });

  it('generates staging fallback secret lazily and keeps it stable within the same isolate', async () => {
    vi.resetModules();
    const randomUuidSpy = vi.spyOn(crypto, 'randomUUID');

    const { getServerConfig: isolatedGetConfig } = await import('../src/server/env.ts');
    expect(randomUuidSpy).not.toHaveBeenCalled();

    const first = isolatedGetConfig({ AVAREST_ENVIRONMENT: 'staging' });
    expect(randomUuidSpy).toHaveBeenCalledTimes(1);
    expect(first.authSessionSecret.startsWith('avarest-local-')).toBe(true);
    expect(first.authSessionSecret.length).toBeGreaterThanOrEqual(16);

    const second = isolatedGetConfig({ AVAREST_ENVIRONMENT: 'staging' });
    expect(randomUuidSpy).toHaveBeenCalledTimes(1);
    expect(second.authSessionSecret).toBe(first.authSessionSecret);
  });

  it('fails closed in production when AUTH_SESSION_SECRET is missing, weak, or placeholder', async () => {
    vi.resetModules();
    const randomUuidSpy = vi.spyOn(crypto, 'randomUUID');
    const { getServerConfig: isolatedGetConfig } = await import('../src/server/env.ts');
    const { signSessionToken, verifySessionToken } = await import('../src/server/lib/crypto.ts');
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');

    for (const badSecret of [undefined, '', 'short-secret', 'YOUR_AUTH_SESSION_SECRET']) {
      const prodCfg = isolatedGetConfig({
        AVAREST_ENVIRONMENT: 'production',
        VITE_ENVIRONMENT: 'production',
        SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        VITE_SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-test',
        VITE_SUPABASE_ANON_KEY: 'prod-anon-test',
        ...(badSecret !== undefined ? { AUTH_SESSION_SECRET: badSecret } : {}),
      });

      expect(prodCfg.authSessionSecret).toBe('');
      expect(prodCfg.configValidation.authSessionSecretStrong).toBe(false);
      expect(prodCfg.configValidation.missingRequired).toContain('AUTH_SESSION_SECRET (>= 16 chars)');
      expect(randomUuidSpy).not.toHaveBeenCalled();
    }

    await expect(
      signSessionToken({ sub: 'u1', email: 'u1@avarestai.com', role: 'user', exp: Date.now() + 60_000 }, ''),
    ).rejects.toThrow();
    expect(await verifySessionToken('a.b.c', '')).toBeNull();

    // Production app with missing AUTH_SESSION_SECRET reports degraded health & blocks protected endpoints (503)
    const prodApp = createAvarestApiApp({
      repoOverride: new MemoryWorkspaceRepository(createStore()),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'production',
        VITE_ENVIRONMENT: 'production',
        SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        VITE_SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-test',
        VITE_SUPABASE_ANON_KEY: 'prod-anon-test',
      },
    });

    const health = await prodApp.request('/api/v1/health');
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as { status: string; configValidation: { authSessionSecretStrong: boolean } };
    expect(healthJson.status).toBe('degraded');
    expect(healthJson.configValidation.authSessionSecretStrong).toBe(false);

    const protectedRes = await prodApp.request('/api/v1/projects', {
      headers: { Authorization: 'Bearer any-token' },
    });
    expect(protectedRes.status).toBe(503);
    const protectedJson = (await protectedRes.json()) as { error: { code: string } };
    expect(protectedJson.error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('works in production when a valid strong AUTH_SESSION_SECRET and production Supabase config are provided', async () => {
    const prodSecret = 'prod-strong-session-secret-0123456789abcdef';
    const prodCfg = getServerConfig({
      AVAREST_ENVIRONMENT: 'production',
      VITE_ENVIRONMENT: 'production',
      SUPABASE_URL: SUPABASE_PROJECTS.production.url,
      VITE_SUPABASE_URL: SUPABASE_PROJECTS.production.url,
      SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-test',
      VITE_SUPABASE_ANON_KEY: 'prod-anon-test',
      AUTH_SESSION_SECRET: prodSecret,
    });

    expect(prodCfg.environment).toBe('production');
    expect(prodCfg.supabaseConfigured).toBe(true);
    expect(prodCfg.isolationErrors).toHaveLength(0);
    expect(prodCfg.configValidation.authSessionSecretStrong).toBe(true);
    expect(prodCfg.configValidation.missingRequired).toHaveLength(0);
    expect(prodCfg.authSessionSecret).toBe(prodSecret);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/rest/v1/')) {
          return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(
          JSON.stringify({ id: 'supa-u1', email: 'produser@avarestai.com', user_metadata: { full_name: 'Prod User' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const prodApp = createAvarestApiApp({
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'production',
        VITE_ENVIRONMENT: 'production',
        SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        VITE_SUPABASE_URL: SUPABASE_PROJECTS.production.url,
        SUPABASE_SERVICE_ROLE_KEY: 'prod-service-role-test',
        VITE_SUPABASE_ANON_KEY: 'prod-anon-test',
        AUTH_SESSION_SECRET: prodSecret,
      },
    });

    const health = await prodApp.request('/api/v1/health');
    expect(health.status).toBe(200);
    const healthJson = (await health.json()) as { status: string; environment: string };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.environment).toBe('production');
  });

  it('allows avarest-ai-staging.avarestglobal.workers.dev in CORS while rejecting arbitrary workers.dev origins', async () => {
    const app = createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
      },
    });

    const stagingWorkersPreflight = await app.request('/api/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://avarest-ai-staging.avarestglobal.workers.dev' },
    });
    expect(stagingWorkersPreflight.status).toBe(204);
    expect(stagingWorkersPreflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://avarest-ai-staging.avarestglobal.workers.dev',
    );

    const untrustedWorkersPreflight = await app.request('/api/v1/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://malicious-clone.workers.dev' },
    });
    expect(untrustedWorkersPreflight.status).toBe(403);
    expect(untrustedWorkersPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('verifies wrangler.toml [env.staging] vars and absence of misnamed or leaked VITE_ variables', () => {
    const wranglerToml = fs.readFileSync(path.resolve(process.cwd(), 'wrangler.toml'), 'utf-8');
    expect(wranglerToml).toContain('[env.staging]');
    expect(wranglerToml).toContain('name = "avarest-ai-staging"');
    expect(wranglerToml).toContain('AVAREST_ENVIRONMENT = "staging"');
    expect(wranglerToml).toContain('VITE_ENVIRONMENT = "staging"');
    expect(wranglerToml).toContain('SUPABASE_URL = "https://wdbtszlcdliwacvztmjl.supabase.co"');
    expect(wranglerToml).toContain('VITE_SUPABASE_URL = "https://wdbtszlcdliwacvztmjl.supabase.co"');
    expect(wranglerToml).toContain('APP_URL = "https://avarest-ai-staging.avarestglobal.workers.dev"');
    expect(wranglerToml).toContain('[env.staging.assets]');
    expect(wranglerToml).toContain('directory = "./dist"');
    expect(wranglerToml).toContain('binding = "ASSETS"');
    expect(wranglerToml).toContain('not_found_handling = "single-page-application"');
    expect(wranglerToml).toContain('run_worker_first = ["/api", "/api/*"]');
    expect(wranglerToml).toContain('[[env.staging.kv_namespaces]]');
    expect(wranglerToml).toContain('binding = "RATE_LIMIT_KV"');
    expect(wranglerToml).toContain('id = "6d9baaa1ad3a485b958fce667a5ad16a"');
    expect(wranglerToml).not.toContain('[[env.production.kv_namespaces]]');
    expect(wranglerToml).not.toContain('[env.production.assets]');
    // Production block remains untouched
    expect(wranglerToml).toContain('[env.production]');
    expect(wranglerToml).toContain('SUPABASE_URL = "https://zdvhksmtxelxcudssdus.supabase.co"');
    expect(wranglerToml).toContain('APP_URL = "https://avarestai.com"');

    // Verify no misnamed VITE_SUPABASE_STAGING_ANON_KEY or VITE_-prefixed server secrets exist
    expect(wranglerToml).not.toContain('VITE_SUPABASE_STAGING_ANON_KEY');
    expect(wranglerToml).not.toContain('VITE_SUPABASE_SERVICE_ROLE_KEY');
    expect(wranglerToml).not.toContain('VITE_GEMINI_API_KEY');

    const envTs = fs.readFileSync(path.resolve(process.cwd(), 'src/server/env.ts'), 'utf-8');
    expect(envTs).toContain('VITE_SUPABASE_URL');
    expect(envTs).toContain('VITE_SUPABASE_ANON_KEY');
    expect(envTs).toContain('GEMINI_API_KEY');
    expect(envTs).not.toContain('VITE_SUPABASE_STAGING_ANON_KEY');
  });

  it('serves root and SPA routes via ASSETS, preserves /api/v1/health, and returns JSON 404 for unknown API routes', async () => {
    const htmlContent = '<!doctype html><html><body><div id="root">Avarest One</div></body></html>';
    const jsContent = 'console.log("avarest-bundle");';

    const mockAssets = {
      async fetch(input: Request | URL | string) {
        const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(htmlContent, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (url.pathname === '/assets/app.js') {
          return new Response(jsContent, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
        }
        return new Response('Not Found', { status: 404 });
      },
    };

    const stagingEnv = {
      AVAREST_ENVIRONMENT: 'staging',
      VITE_ENVIRONMENT: 'staging',
      SUPABASE_URL: SUPABASE_PROJECTS.staging.url,
      VITE_SUPABASE_URL: SUPABASE_PROJECTS.staging.url,
      ASSETS: mockAssets,
    };

    // 1. Root frontend response
    const rootRes = await workerApp.fetch(new Request('https://avarest-ai-staging.avarestglobal.workers.dev/'), stagingEnv);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('Content-Type')).toContain('text/html');
    expect(await rootRes.text()).toContain('Avarest One');

    // 2. Direct static asset response
    const jsRes = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/assets/app.js'),
      stagingEnv,
    );
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('Content-Type')).toContain('application/javascript');

    // 3. SPA route fallback (direct navigation / browser refresh on /chat or /projects/123)
    const spaRes = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/chat'),
      stagingEnv,
    );
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get('Content-Type')).toContain('text/html');
    expect(await spaRes.text()).toContain('Avarest One');

    // 4. Missing static asset with extension stays 404 (not HTML)
    const missingAssetRes = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/assets/nonexistent.js'),
      stagingEnv,
    );
    expect(missingAssetRes.status).toBe(404);

    // 5. API health endpoint continues working
    const healthRes = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/api/v1/health'),
      stagingEnv,
    );
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string; environment: string };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.environment).toBe('staging');

    // 6. Unknown API routes return JSON 404, never frontend HTML
    const unknownApiV1 = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/api/v1/does-not-exist'),
      stagingEnv,
    );
    expect(unknownApiV1.status).toBe(404);
    expect(unknownApiV1.headers.get('Content-Type')).toContain('application/json');
    const unknownApiV1Json = (await unknownApiV1.json()) as { error: { code: string } };
    expect(unknownApiV1Json.error.code).toBe('NOT_FOUND');

    const unknownApiRoot = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/api'),
      stagingEnv,
    );
    expect(unknownApiRoot.status).toBe(404);
    expect(unknownApiRoot.headers.get('Content-Type')).toContain('application/json');
  });

  it('distinguishes a real KV namespace binding from a plain-text RATE_LIMIT_KV variable without crashing', async () => {
    // Plain-text string must NOT be reported as distributed_kv or crash rate-limited routes
    const plainTextEnv = {
      AVAREST_ENVIRONMENT: 'staging',
      RATE_LIMIT_KV: 'avarest-ai-staging-rate-limit',
    };

    const cfgPlain = getServerConfig(plainTextEnv);
    expect(cfgPlain.hasRateLimitKv).toBe(false);
    expect(cfgPlain.configValidation.missingOptional).toContain('RATE_LIMIT_KV');
    expect(cfgPlain.configValidation.warnings.some((w) => w.includes('RATE_LIMIT_KV'))).toBe(true);

    const healthPlain = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/api/v1/health'),
      plainTextEnv,
    );
    expect(healthPlain.status).toBe(200);
    const healthPlainJson = (await healthPlain.json()) as {
      rateLimitMode: string;
      configValidation: { warnings: string[] };
    };
    expect(healthPlainJson.rateLimitMode).toBe('single_instance_memory');
    expect(healthPlainJson.configValidation.warnings.some((w) => w.includes('RATE_LIMIT_KV'))).toBe(true);

    // Rate-limited route still responds cleanly instead of throwing `this.kv.get is not a function`
    const rateLimitedRoute = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@avarestai.com', password: 'wrong' }),
      }),
      plainTextEnv,
    );
    expect(rateLimitedRoute.status).toBe(401);

    // Real KV namespace binding reports distributed_kv and sets hasRateLimitKv = true
    const kvMap = new Map<string, string>();
    const realKvEnv = {
      AVAREST_ENVIRONMENT: 'staging',
      RATE_LIMIT_KV: {
        async get(key: string) {
          return kvMap.get(key) ?? null;
        },
        async put(key: string, value: string) {
          kvMap.set(key, value);
        },
      },
    };
    const cfgReal = getServerConfig(realKvEnv);
    expect(cfgReal.hasRateLimitKv).toBe(true);

    const healthReal = await workerApp.fetch(
      new Request('https://avarest-ai-staging.avarestglobal.workers.dev/api/v1/health'),
      realKvEnv,
    );
    const healthRealJson = (await healthReal.json()) as { rateLimitMode: string };
    expect(healthRealJson.rateLimitMode).toBe('distributed_kv');
  });
});

describe('Staging Supabase Auth Session Verification & Token Lifecycle', () => {
  const STAGING_SUPABASE_BINDINGS = {
    AVAREST_ENVIRONMENT: 'staging',
    VITE_ENVIRONMENT: 'staging',
    SUPABASE_URL: SUPABASE_PROJECTS.staging.url,
    VITE_SUPABASE_URL: SUPABASE_PROJECTS.staging.url,
    SUPABASE_SERVICE_ROLE_KEY: 'staging-service-role-test-key',
    VITE_SUPABASE_ANON_KEY: 'staging-anon-test-key',
  };

  it('verifies a valid Staging Supabase JWT cleanly via /api/v1/auth/session and persists profile', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const repo = new MemoryWorkspaceRepository(createStore());
    const validJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdXBhLXN0YWdpbmctdTEifQ.sig123';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      expect(url).toBe(`${SUPABASE_PROJECTS.staging.url}/auth/v1/user`);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${validJwt}`);
      expect(headers.get('apikey')).toBe('staging-service-role-test-key');
      return new Response(
        JSON.stringify({
          id: 'supa-staging-u1',
          email: 'staging.user@avarestai.com',
          user_metadata: { full_name: 'Staging Tester' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = createAvarestApiApp({
      repoOverride: repo,
      bindingsOverride: STAGING_SUPABASE_BINDINGS,
    });

    const sessionRes = await app.request('/api/v1/auth/session', {
      headers: { Authorization: `Bearer ${validJwt}` },
    });
    expect(sessionRes.status).toBe(200);
    const sessionJson = (await sessionRes.json()) as { user: { id: string; email: string; fullName: string } };
    expect(sessionJson.user.id).toBe('supa-staging-u1');
    expect(sessionJson.user.email).toBe('staging.user@avarestai.com');
    expect(sessionJson.user.fullName).toBe('Staging Tester');

    // Subsequent authenticated API call with same session succeeds
    const projectsRes = await app.request('/api/v1/projects', {
      headers: { Authorization: `Bearer ${validJwt}` },
    });
    expect(projectsRes.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unauthenticated, malformed, and invalid/expired tokens with 401 rather than 502', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const repo = new MemoryWorkspaceRepository(createStore());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'JWT expired' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = createAvarestApiApp({
      repoOverride: repo,
      bindingsOverride: STAGING_SUPABASE_BINDINGS,
    });

    // Unauthenticated API access
    const unauth = await app.request('/api/v1/auth/session');
    expect(unauth.status).toBe(401);

    // Malformed / non-ASCII / non-JWT token rejected before calling fetch() (prevents ByteString TypeError -> 502)
    const malformed = await app.request('/api/v1/auth/session', {
      headers: { Authorization: 'Bearer invalid-not-a-jwt' },
    });
    expect(malformed.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const nonAscii = await app.request('/api/v1/auth/session', {
      headers: { Authorization: 'Bearer aaa.bbb.ccc\u00e9' },
    });
    expect(nonAscii.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    // Expired/invalid Supabase JWT returns 401 UNAUTHORIZED
    const expiredJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.expired';
    const expiredRes = await app.request('/api/v1/auth/session', {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });
    expect(expiredRes.status).toBe(401);
    const expiredJson = (await expiredRes.json()) as { error: { code: string } };
    expect(expiredJson.error.code).toBe('UNAUTHORIZED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not misreport profile DB failures or downstream route errors as "Unable to verify session with Supabase Auth."', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const validJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdXBhLXN0YWdpbmctdTIifQ.sig456';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'supa-staging-u2',
            email: 'dbcheck@avarestai.com',
            user_metadata: { full_name: 'DB Check' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    // 1. Profile DB upsert failure must return 503 PROFILE_SYNC_ERROR, not 502 AUTH_UPSTREAM_ERROR
    const failingProfileRepo = new MemoryWorkspaceRepository(createStore());
    failingProfileRepo.upsertProfileFromSupabaseAuth = async () => {
      throw new Error('duplicate key value violates unique constraint');
    };
    const appProfileFail = createAvarestApiApp({
      repoOverride: failingProfileRepo,
      bindingsOverride: STAGING_SUPABASE_BINDINGS,
    });
    const profileErrRes = await appProfileFail.request('/api/v1/auth/session', {
      headers: { Authorization: `Bearer ${validJwt}` },
    });
    expect(profileErrRes.status).toBe(503);
    const profileErrJson = (await profileErrRes.json()) as { error: { code: string; message: string } };
    expect(profileErrJson.error.code).toBe('PROFILE_SYNC_ERROR');
    expect(profileErrJson.error.message).not.toContain('Unable to verify session with Supabase Auth');

    // 2. Downstream route exception must hit Hono onError (500 INTERNAL_ERROR), never auth middleware catch (502)
    const failingRouteRepo = new MemoryWorkspaceRepository(createStore());
    failingRouteRepo.listProjects = async () => {
      throw new Error('Transient downstream query error');
    };
    const appRouteFail = createAvarestApiApp({
      repoOverride: failingRouteRepo,
      bindingsOverride: STAGING_SUPABASE_BINDINGS,
    });
    const routeErrRes = await appRouteFail.request('/api/v1/projects', {
      headers: { Authorization: `Bearer ${validJwt}` },
    });
    expect(routeErrRes.status).toBe(500);
    const routeErrJson = (await routeErrRes.json()) as { error: { code: string; message: string } };
    expect(routeErrJson.error.code).toBe('INTERNAL_ERROR');
    expect(routeErrJson.error.message).not.toContain('Unable to verify session with Supabase Auth');
  });

  it('restores, refreshes expiring tokens, clears stale localStorage on logout/empty session', async () => {
    const storageMap = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
    });

    vi.resetModules();

    // Case A: Stale localStorage token is purged when Supabase has no active session (e.g. after logout or expiry)
    vi.doMock('../src/lib/supabaseClient.ts', () => ({
      getPublicSupabaseClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          refreshSession: async () => ({ data: { session: null }, error: null }),
        },
      }),
    }));
    const apiModA = await import('../src/lib/api.ts');
    apiModA.setStoredToken('stale-old-token-in-localstorage');
    expect(await apiModA.resolveActiveAuthToken()).toBeNull();
    expect(apiModA.getStoredToken()).toBeNull();

    // Case B: Active session expiring within 10s automatically refreshes and persists the new access token
    vi.resetModules();
    const refreshMock = vi.fn(async () => ({
      data: {
        session: {
          access_token: 'fresh-refreshed-jwt.payload.sig',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    }));
    vi.doMock('../src/lib/supabaseClient.ts', () => ({
      getPublicSupabaseClient: () => ({
        auth: {
          getSession: async () => ({
            data: {
              session: {
                access_token: 'expiring-jwt.payload.sig',
                expires_at: Math.floor(Date.now() / 1000) + 2,
              },
            },
            error: null,
          }),
          refreshSession: refreshMock,
        },
      }),
    }));
    const apiModB = await import('../src/lib/api.ts');
    const resolved = await apiModB.resolveActiveAuthToken();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(resolved).toBe('fresh-refreshed-jwt.payload.sig');
    expect(apiModB.getStoredToken()).toBe('fresh-refreshed-jwt.payload.sig');

    // Logout clears stored token
    apiModB.setStoredToken(null);
    expect(apiModB.getStoredToken()).toBeNull();
    vi.doUnmock('../src/lib/supabaseClient.ts');
  });
});

describe('Staging Credit Reservation Lifecycle, Agent Accounting & Admin Security', () => {
  async function setupStagingAppWithUser(options?: { initialBalance?: number; openAiFetch?: typeof fetch }) {
    const store = createStore();
    if (options?.openAiFetch) {
      vi.stubGlobal('fetch', options.openAiFetch);
    }
    const app = createAvarestApiApp({
      store,
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
        ADMIN_BOOTSTRAP_SECRET: 'bootstrap-secret-vitest-12345678',
        OPENAI_API_KEY: 'sk-staging-test-key',
      },
    });

    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `user-${crypto.randomUUID()}@avarestai.com`,
        password: 'StrongPassword#1234',
        fullName: 'Credit Tester',
      }),
    });
    const { token, user } = (await reg.json()) as { token: string; user: { id: string; email: string } };
    if (options?.initialBalance !== undefined) {
      store.credits.set(user.id, { balance: options.initialBalance, monthlyAllowance: 100 });
    }
    return { app, store, token, userId: user.id };
  }

  it('1. insufficient balance blocks provider execution across chat, research, coder, and immediate agents', async () => {
    const providerFetch = vi.fn(async () => new Response('Should never be called', { status: 200 }));
    const { app, store, token, userId } = await setupStagingAppWithUser({
      initialBalance: 0.05,
      openAiFetch: providerFetch as unknown as typeof fetch,
    });

    const agentRes = await app.request('/api/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Immediate Blocked Agent',
        category: 'coding',
        instructions: 'Analyze code',
        requireApproval: false,
      }),
    });
    const agentId = ((await agentRes.json()) as { agent: { id: string } }).agent.id;

    const chatRes = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'Hello', routingMode: 'auto' }),
    });
    expect(chatRes.status).toBe(402);

    const streamRes = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'Hello stream', routingMode: 'auto', stream: true }),
    });
    expect(streamRes.status).toBe(402);

    const researchRes = await app.request('/api/v1/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'Analyze security architecture' }),
    });
    expect(researchRes.status).toBe(402);

    const coderRes = await app.request('/api/v1/coder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskType: 'review', language: 'TypeScript', prompt: 'Review auth module' }),
    });
    expect(coderRes.status).toBe(402);

    const agentRunRes = await app.request(`/api/v1/agents/${agentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputTask: 'Audit credits' }),
    });
    expect(agentRunRes.status).toBe(402);

    expect(providerFetch).not.toHaveBeenCalled();
    expect(store.credits.get(userId)?.balance).toBe(0.05);
  });

  it('2. two concurrent reservations cannot overspend the same account', async () => {
    const providerFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Concurrent ok' } }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const { app, store, token, userId } = await setupStagingAppWithUser({
      initialBalance: 0.7,
      openAiFetch: providerFetch as unknown as typeof fetch,
    });

    // Each chat reserves ~0.503+ credits, so only 1 of 2 concurrent requests can reserve from 0.7
    const [r1, r2] = await Promise.all([
      app.request('/api/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: 'Concurrent one', routingMode: 'auto' }),
      }),
      app.request('/api/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: 'Concurrent two', routingMode: 'auto' }),
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 402]);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(store.credits.get(userId)!.balance).toBeGreaterThanOrEqual(0);
    expect(store.credits.get(userId)!.balance).toBe(0.5);
  });

  it('3. duplicate reservation request is idempotent at repository and HTTP idempotency layers', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const store = createStore();
    store.credits.set('u-idem', { balance: 10, monthlyAllowance: 100 });
    const repo = new MemoryWorkspaceRepository(store);

    const first = await repo.reserveCredits({
      userId: 'u-idem',
      amount: 2.5,
      feature: 'chat',
      reason: 'Chat test',
      referenceId: 'req-idem-1',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.balanceAfter).toBe(7.5);

    const second = await repo.reserveCredits({
      userId: 'u-idem',
      amount: 2.5,
      feature: 'chat',
      reason: 'Chat test',
      referenceId: 'req-idem-1',
    });
    expect(second.deduplicated).toBe(true);
    expect(second.balanceAfter).toBe(7.5);
    expect(second.reservation.id).toBe(first.reservation.id);
    expect(store.credits.get('u-idem')?.balance).toBe(7.5);

    // HTTP-level Idempotency-Key replay cannot invoke provider or charge a second time
    const providerFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Once' } }],
          usage: { prompt_tokens: 50, completion_tokens: 50 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { app, store: appStore, token, userId } = await setupStagingAppWithUser({
      initialBalance: 10,
      openAiFetch: providerFetch as unknown as typeof fetch,
    });
    const firstHttp = await app.request('/api/v1/coder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'coder-retry-key-1',
      },
      body: JSON.stringify({ taskType: 'explain', language: 'TypeScript', prompt: 'Explain promises' }),
    });
    expect(firstHttp.status).toBe(200);

    const replayHttp = await app.request('/api/v1/coder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'coder-retry-key-1',
      },
      body: JSON.stringify({ taskType: 'explain', language: 'TypeScript', prompt: 'Explain promises' }),
    });
    expect(replayHttp.status).toBe(409);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(appStore.credits.get(userId)?.balance).toBe(9.8);
  });

  it('4. duplicate finalization does not double-charge or double-refund', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const store = createStore();
    store.credits.set('u-fin', { balance: 20, monthlyAllowance: 100 });
    const repo = new MemoryWorkspaceRepository(store);

    await repo.reserveCredits({
      userId: 'u-fin',
      amount: 4,
      feature: 'research',
      reason: 'Research',
      referenceId: 'fin-ref-1',
    });
    expect(store.credits.get('u-fin')?.balance).toBe(16);

    const fin1 = await repo.finalizeCreditReservation({
      userId: 'u-fin',
      referenceId: 'fin-ref-1',
      actualAmount: 1.25,
    });
    expect(fin1.deduplicated).toBe(false);
    expect(fin1.balanceAfter).toBe(18.75);
    expect(fin1.reservation.status).toBe('finalized');
    expect(fin1.reservation.actualAmount).toBe(1.25);

    const fin2 = await repo.finalizeCreditReservation({
      userId: 'u-fin',
      referenceId: 'fin-ref-1',
      actualAmount: 1.25,
    });
    expect(fin2.deduplicated).toBe(true);
    expect(fin2.balanceAfter).toBe(18.75);
    expect(store.credits.get('u-fin')?.balance).toBe(18.75);
  });

  it('5. provider failure releases the reservation completely across execution endpoints', async () => {
    const failingFetch = vi.fn(async () => new Response('Upstream bad gateway', { status: 502 }));
    const { app, store, token, userId } = await setupStagingAppWithUser({
      initialBalance: 10,
      openAiFetch: failingFetch as unknown as typeof fetch,
    });

    const chatFail = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'Fail chat', routingMode: 'auto' }),
    });
    expect(chatFail.status).toBe(502);
    expect(store.credits.get(userId)?.balance).toBe(10);

    const researchFail = await app.request('/api/v1/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'Fail research topic' }),
    });
    expect(researchFail.status).toBe(502);
    expect(store.credits.get(userId)?.balance).toBe(10);

    const coderFail = await app.request('/api/v1/coder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ taskType: 'debug', language: 'TypeScript', prompt: 'Fail coder' }),
    });
    expect(coderFail.status).toBe(502);
    expect(store.credits.get(userId)?.balance).toBe(10);

    const reservations = Array.from(store.creditReservations.values()).filter((r) => r.userId === userId);
    expect(reservations).toHaveLength(3);
    expect(reservations.every((r) => r.status === 'released' && r.actualAmount === 0)).toBe(true);
  });

  it('6. streaming cancellation releases reservation without charging credits', async () => {
    const encoder = new TextEncoder();
    const slowStreamFetch = vi.fn(async () => {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial "}}]}\n\n'));
          await new Promise((r) => setTimeout(r, 40));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"tail"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const { app, store, token, userId } = await setupStagingAppWithUser({
      initialBalance: 10,
      openAiFetch: slowStreamFetch as unknown as typeof fetch,
    });

    const abortController = new AbortController();
    const streamRes = await app.request(
      '/api/v1/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: 'Stream cancel test', routingMode: 'auto', stream: true }),
        signal: abortController.signal,
      },
    );
    expect(streamRes.status).toBe(200);
    // Abort request and cancel stream reader immediately
    abortController.abort();
    await streamRes.body?.cancel();
    await new Promise((r) => setTimeout(r, 60));

    expect(store.credits.get(userId)?.balance).toBe(10);
    const reservations = Array.from(store.creditReservations.values()).filter((r) => r.userId === userId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('released');
  });

  it('7. actual cost reconciliation returns unused reserved credits to user balance', async () => {
    const providerFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Concise reply' } }],
          usage: { prompt_tokens: 150, completion_tokens: 50 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { app, store, token, userId } = await setupStagingAppWithUser({
      initialBalance: 10,
      openAiFetch: providerFetch as unknown as typeof fetch,
    });

    const res = await app.request('/api/v1/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'Compare relational lock strategies in PostgreSQL' }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { creditsCharged: number; balanceAfter: number };
    // Actual tokens = 200 -> 0.2 raw, min research cost = 0.25 (while estimated reservation > 1.2)
    expect(json.creditsCharged).toBe(0.25);
    expect(json.balanceAfter).toBe(9.75);
    expect(store.credits.get(userId)?.balance).toBe(9.75);

    const resv = Array.from(store.creditReservations.values())[0];
    expect(resv.status).toBe('finalized');
    expect(resv.reservedAmount).toBeGreaterThan(0.25);
    expect(resv.actualAmount).toBe(0.25);
  });

  it('8. AI Agent immediate and approval executions enforce credit reservation, reconciliation, and release on failure', async () => {
    let callCount = 0;
    const providerFetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 3) {
        return new Response('Agent upstream outage', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `Agent output #${callCount}` } }],
          usage: { prompt_tokens: 200, completion_tokens: 150 }, // 0.35 credits
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { app, store, token, userId } = await setupStagingAppWithUser({
      initialBalance: 10,
      openAiFetch: providerFetch as unknown as typeof fetch,
    });

    // A) Immediate agent execution deducts actual usage (0.35 credits)
    const immAgentRes = await app.request('/api/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Immediate Agent',
        category: 'coding',
        instructions: 'Execute immediate task',
        requireApproval: false,
      }),
    });
    const immAgentId = ((await immAgentRes.json()) as { agent: { id: string } }).agent.id;
    const immRunRes = await app.request(`/api/v1/agents/${immAgentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputTask: 'Generate schema summary' }),
    });
    expect(immRunRes.status).toBe(201);
    const immRunJson = (await immRunRes.json()) as { run: { status: string } };
    expect(immRunJson.run.status).toBe('completed');
    expect(store.credits.get(userId)?.balance).toBe(9.65);

    // B) Approval-gated agent execution reserves & settles on approve (another 0.35 credits)
    const appAgentRes = await app.request('/api/v1/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Approval Agent',
        category: 'research',
        instructions: 'Wait for approval',
        requireApproval: true,
      }),
    });
    const appAgentId = ((await appAgentRes.json()) as { agent: { id: string } }).agent.id;
    const gatedRunRes = await app.request(`/api/v1/agents/${appAgentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputTask: 'Audit staged queries' }),
    });
    const gatedRun = (await gatedRunRes.json()) as { run: { pendingApproval: { id: string } } };

    // Concurrent duplicate approve only executes once
    const [approve1, approve2] = await Promise.all([
      app.request(`/api/v1/agents/approvals/${gatedRun.run.pendingApproval.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: 'approved' }),
      }),
      app.request(`/api/v1/agents/approvals/${gatedRun.run.pendingApproval.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ decision: 'approved' }),
      }),
    ]);
    expect([approve1.status, approve2.status].sort()).toEqual([200, 400]);
    expect(store.credits.get(userId)?.balance).toBe(9.3);

    // C) Provider failure on immediate agent releases reservation cleanly
    const failedImmRun = await app.request(`/api/v1/agents/${immAgentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputTask: 'Trigger outage' }),
    });
    expect(failedImmRun.status).toBe(201);
    const failedJson = (await failedImmRun.json()) as { run: { status: string } };
    expect(failedJson.run.status).toBe('failed');
    expect(store.credits.get(userId)?.balance).toBe(9.3);

    // D) Approval-gated agent blocked with 402 when balance drops below estimate before approve
    const gatedRunRes2 = await app.request(`/api/v1/agents/${appAgentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inputTask: 'Should fail 402 on approve' }),
    });
    const gatedRun2 = (await gatedRunRes2.json()) as { run: { pendingApproval: { id: string } } };
    store.credits.set(userId, { balance: 0.05, monthlyAllowance: 100 });
    const lowBalApprove = await app.request(`/api/v1/agents/approvals/${gatedRun2.run.pendingApproval.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(lowBalApprove.status).toBe(402);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it('9. unauthorized users cannot access any /api/v1/admin/* route including /admin/credits/reconcile', async () => {
    const { app, token, userId } = await setupStagingAppWithUser({ initialBalance: 50 });

    const adminEndpoints: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/v1/admin/overview' },
      { method: 'GET', path: '/api/v1/admin/provider-health' },
      { method: 'GET', path: '/api/v1/admin/users' },
      { method: 'PATCH', path: `/api/v1/admin/users/${userId}/role`, body: { role: 'super_admin' } },
      { method: 'GET', path: '/api/v1/admin/audit-logs' },
      { method: 'GET', path: '/api/v1/admin/flags' },
      { method: 'PATCH', path: '/api/v1/admin/flags/streaming_chat', body: { enabled: false } },
      { method: 'PATCH', path: '/api/v1/admin/policies/default', body: { active: false } },
      { method: 'POST', path: '/api/v1/admin/credits/reconcile' },
      { method: 'GET', path: '/api/v1/admin/bootstrap' },
    ];

    for (const ep of adminEndpoints) {
      const unauth = await app.request(ep.path, {
        method: ep.method,
        ...(ep.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ep.body) } : {}),
      });
      expect(unauth.status).toBe(401);

      const nonAdmin = await app.request(ep.path, {
        method: ep.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(ep.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
      });
      expect(nonAdmin.status).toBe(403);
    }
  });

  it('10. admin bootstrap fails closed when countAdmins() encounters a database error', async () => {
    // 1. SupabaseWorkspaceRepository.countAdmins() must throw on DB error instead of returning 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ message: 'connection to postgres refused' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const { SupabaseWorkspaceRepository } = await import('../src/server/lib/supabaseRepo.ts');
    const supaRepo = new SupabaseWorkspaceRepository(SUPABASE_PROJECTS.staging.url, 'staging-service-role-key');
    await expect(supaRepo.countAdmins()).rejects.toThrow();

    // 2. /api/v1/admin/bootstrap returns 503 BOOTSTRAP_VERIFICATION_FAILED and refuses promotion
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const store = createStore();
    const failingRepo = new MemoryWorkspaceRepository(store);
    failingRepo.countAdmins = async () => {
      throw new Error('relation "profiles" read timeout');
    };

    const app = createAvarestApiApp({
      repoOverride: failingRepo,
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
        ADMIN_BOOTSTRAP_SECRET: 'bootstrap-secret-vitest-12345678',
      },
    });

    const res = await app.request('/api/v1/admin/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-bootstrap-secret': 'bootstrap-secret-vitest-12345678',
      },
      body: JSON.stringify({
        email: 'attacker@avarestai.com',
        password: 'StrongPassword#2026',
        fullName: 'Attacker',
      }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('BOOTSTRAP_VERIFICATION_FAILED');
    expect(store.users.size).toBe(0);
  });

  it('11. User A cannot reserve, finalize, or release User B credits or reservations', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const store = createStore();
    store.credits.set('user-a', { balance: 10, monthlyAllowance: 100 });
    store.credits.set('user-b', { balance: 10, monthlyAllowance: 100 });
    const repo = new MemoryWorkspaceRepository(store);

    await repo.reserveCredits({
      userId: 'user-b',
      amount: 3,
      feature: 'chat',
      reason: 'User B chat',
      referenceId: 'only-user-b-ref',
    });
    expect(store.credits.get('user-b')?.balance).toBe(7);

    // User A attempting to finalize or release User B's reservation reference fails cleanly
    await expect(
      repo.finalizeCreditReservation({ userId: 'user-a', referenceId: 'only-user-b-ref', actualAmount: 0.1 }),
    ).rejects.toThrow('RESERVATION_NOT_FOUND');
    await expect(
      repo.releaseCreditReservation({ userId: 'user-a', referenceId: 'only-user-b-ref' }),
    ).rejects.toThrow('RESERVATION_NOT_FOUND');

    // User B's reservation and balance remain completely unchanged
    expect(store.credits.get('user-b')?.balance).toBe(7);
    expect(store.credits.get('user-a')?.balance).toBe(10);

    // API level: User A sending a forged userId in body only touches User A's own balance
    const providerFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Isolated ok' } }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const { app, store: appStore, token: tokenA, userId: userA } = await setupStagingAppWithUser({
      initialBalance: 10,
      openAiFetch: providerFetch as unknown as typeof fetch,
    });
    const regB = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'victim-b@avarestai.com', password: 'StrongPassword#1234', fullName: 'Victim B' }),
    });
    const userB = ((await regB.json()) as { user: { id: string } }).user.id;
    appStore.credits.set(userB, { balance: 25, monthlyAllowance: 100 });

    const chatRes = await app.request('/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ prompt: 'Hello', userId: userB }),
    });
    expect(chatRes.status).toBe(200);
    expect(appStore.credits.get(userA)?.balance).toBe(9.8);
    expect(appStore.credits.get(userB)?.balance).toBe(25);
  });

  it('12. expired reservations are safely reconciled and prevent double-refunds', async () => {
    const { MemoryWorkspaceRepository } = await import('../src/server/lib/repository.ts');
    const store = createStore();
    store.credits.set('u-exp', { balance: 10, monthlyAllowance: 100 });
    const repo = new MemoryWorkspaceRepository(store);

    const resv = await repo.reserveCredits({
      userId: 'u-exp',
      amount: 4.5,
      feature: 'chat_stream',
      reason: 'Abandoned stream',
      referenceId: 'abandoned-stream-1',
      ttlSeconds: 60,
    });
    expect(store.credits.get('u-exp')?.balance).toBe(5.5);

    // Simulate Worker termination leaving reservation expired in the past
    const storedResv = store.creditReservations.get(`u-exp::abandoned-stream-1`)!;
    storedResv.expiresAt = new Date(Date.now() - 5_000).toISOString();

    const sweep1 = await repo.reconcileExpiredReservations({ userId: 'u-exp' });
    expect(sweep1.reconciledCount).toBe(1);
    expect(sweep1.refundedTotal).toBe(4.5);
    expect(store.credits.get('u-exp')?.balance).toBe(10);
    expect(storedResv.status).toBe('expired');
    expect(resv.reservation.id).toBe(storedResv.id);

    // Re-running reconciliation is idempotent (0 refunded)
    const sweep2 = await repo.reconcileExpiredReservations({ userId: 'u-exp' });
    expect(sweep2.reconciledCount).toBe(0);
    expect(sweep2.refundedTotal).toBe(0);
    expect(store.credits.get('u-exp')?.balance).toBe(10);

    // Next reservation attempt automatically reconciles any newly expired reservation first
    await repo.reserveCredits({
      userId: 'u-exp',
      amount: 6,
      feature: 'research',
      reason: 'Abandoned research',
      referenceId: 'abandoned-res-2',
      ttlSeconds: 60,
    });
    expect(store.credits.get('u-exp')?.balance).toBe(4);
    store.creditReservations.get(`u-exp::abandoned-res-2`)!.expiresAt = new Date(Date.now() - 1_000).toISOString();

    // Balance is 4, new reservation wants 8 -> auto-reconciles expired 6 -> balance 10 -> reserves 8 -> 2 remaining
    const recovered = await repo.reserveCredits({
      userId: 'u-exp',
      amount: 8,
      feature: 'coder',
      reason: 'Follow-up coder',
      referenceId: 'recovered-res-3',
    });
    expect(recovered.balanceAfter).toBe(2);
    expect(store.creditReservations.get(`u-exp::abandoned-res-2`)?.status).toBe('expired');
  });

  it('13. verifies 0003_credit_reservations_and_admin_hardening.sql schema, constraints, RLS, and RPC security', () => {
    const sqlPath = path.resolve(
      process.cwd(),
      'supabase/migrations/0003_credit_reservations_and_admin_hardening.sql',
    );
    const sql = fs.readFileSync(sqlPath, 'utf-8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.credit_reservations');
    expect(sql).toContain('uq_credit_reservations_user_ref UNIQUE (user_id, reference_id)');
    expect(sql).toContain("status IN ('reserved', 'finalized', 'released', 'expired')");
    expect(sql).toContain('ALTER TABLE public.credit_reservations ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('credit_reservations_owner_or_admin_select');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON public.credit_reservations FROM anon, authenticated');
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.reserve_credits');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.finalize_credit_reservation');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.release_credit_reservation');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.reconcile_expired_credit_reservations');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.reserve_credits');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.finalize_credit_reservation');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.release_credit_reservation');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.reconcile_expired_credit_reservations');
    expect(sql).toContain('TO service_role');
    expect(sql).toContain('FOR UPDATE');
  });
});
