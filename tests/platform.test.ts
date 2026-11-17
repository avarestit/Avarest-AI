import { describe, expect, it } from 'vitest';
import { createAvarestApiApp } from '../src/server/app.ts';
import { classifyPromptTask } from '../src/server/brain/classifier.ts';
import { routeWithAvarestBrain, BrainRoutingError } from '../src/server/brain/router.ts';
import { getServerConfig } from '../src/server/env.ts';
import { createStore, deductCreditsAtomic } from '../src/server/lib/store.ts';
import { SUPABASE_PROJECTS, validateEnvironmentIsolation } from '../src/shared/env.ts';

describe('Supabase Environment Isolation', () => {
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
});

describe('Avarest Brain Task Classification & Routing', () => {
  it('classifies coding, research, and general prompts accurately', () => {
    expect(classifyPromptTask('Debug this TypeScript async function error').category).toBe('coding');
    expect(classifyPromptTask('Compare the latest market research evidence and citations').category).toBe('research');
    expect(classifyPromptTask('Hello there, how can I organize my week?').category).toBe('general_chat');
  });

  it('throws NO_CONFIGURED_PROVIDERS when zero API keys exist', () => {
    const config = getServerConfig({ AVAREST_ENVIRONMENT: 'staging', AUTH_SESSION_SECRET: 'test-secret-123' });
    config.providers.gemini = undefined;
    config.providers.openai = undefined;
    config.providers.anthropic = undefined;
    config.providers.deepseek = undefined;
    config.providers.xai = undefined;
    config.providers.llama = undefined;

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

  it('rejects manual selection of an unconfigured model', () => {
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
  });
});

describe('Auth, RBAC, Tenant Isolation, Credits & Approval Checkpoints', () => {
  const createTestApp = () =>
    createAvarestApiApp({
      store: createStore(),
      bindingsOverride: {
        AVAREST_ENVIRONMENT: 'staging',
        AUTH_SESSION_SECRET: 'test-secret-for-vitest-only-32-chars',
      },
    });

  it('enforces authentication and server-side admin RBAC', async () => {
    const app = createTestApp();

    // Unauthenticated blocked
    const unauth = await app.request('/api/v1/projects');
    expect(unauth.status).toBe(401);

    // Register normal user
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

    // Standard user blocked from Admin Console
    const forbidden = await app.request('/api/v1/admin/overview', {
      headers: { Authorization: `Bearer ${regJson.token}` },
    });
    expect(forbidden.status).toBe(403);

    // Admin login succeeds and accesses Admin Console
    const adminLogin = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@avarestai.com',
        password: 'AvarestAdmin#2026',
      }),
    });
    expect(adminLogin.status).toBe(200);
    const adminJson = (await adminLogin.json()) as { token: string };

    const adminOverview = await app.request('/api/v1/admin/overview', {
      headers: { Authorization: `Bearer ${adminJson.token}` },
    });
    expect(adminOverview.status).toBe(200);
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

    // User A creates a project and uploads a knowledge document
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

    // User B cannot delete User A's project or search User A's chunks
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

    // Consent-based memory enforcement
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

    // Integrations never report fake connected status
    const intRes = await app.request('/api/v1/integrations', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(intRes.status).toBe(200);
    const intJson = (await intRes.json()) as { integrations: Array<{ status: string }> };
    expect(intJson.integrations.every((i) => i.status !== 'connected')).toBe(true);
  });

  it('prevents credit overdraft in atomic credit deduction', () => {
    const store = createStore();
    store.credits.set('u1', { balance: 5, monthlyAllowance: 100 });
    const next = deductCreditsAtomic(store, { userId: 'u1', amount: 3, reason: 'Chat' });
    expect(next).toBe(2);
    expect(() => deductCreditsAtomic(store, { userId: 'u1', amount: 4, reason: 'Chat' })).toThrow(
      'INSUFFICIENT_CREDITS',
    );
  });
});
