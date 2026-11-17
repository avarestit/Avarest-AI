import type {
  AgentConfig,
  AgentRun,
  ChatMessage,
  ConnectedAccount,
  Conversation,
  KnowledgeChunkMatch,
  KnowledgeDocument,
  ModelCapabilitySpec,
  Project,
  ResearchReport,
  RoutingDecision,
  RoutingLog,
  SystemHealthStatus,
  UsageSummary,
  UserMemory,
  UserProfile,
  UserRole,
} from '../shared/types.ts';

const TOKEN_STORAGE_KEY = 'avarest_one_session_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const base = (import.meta.env.VITE_API_URL as string | undefined) || '';
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers,
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const code = payload?.error?.code || 'API_ERROR';
    const message = payload?.error?.message || `Request failed with HTTP ${res.status}`;
    throw new ApiError(res.status, code, message);
  }
  return payload as T;
}

export const avarestApi = {
  health: () => apiFetch<SystemHealthStatus>('/api/v1/health'),

  register: (data: { email: string; password: string; fullName: string }) =>
    apiFetch<{ token: string; user: UserProfile }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  login: (data: { email: string; password: string }) =>
    apiFetch<{ token: string; user: UserProfile }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getSession: () => apiFetch<{ user: UserProfile }>('/api/v1/auth/session'),

  updateProfile: (patch: Partial<Pick<UserProfile, 'fullName' | 'language' | 'experienceMode' | 'memoryConsent'>>) =>
    apiFetch<{ user: UserProfile }>('/api/v1/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  getModels: () => apiFetch<{ models: ModelCapabilitySpec[] }>('/api/v1/models'),

  getProjects: () => apiFetch<{ projects: Project[] }>('/api/v1/projects'),
  createProject: (data: { name: string; description?: string; instructions?: string }) =>
    apiFetch<{ project: Project }>('/api/v1/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: Partial<Project>) =>
    apiFetch<{ project: Project }>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/projects/${id}`, { method: 'DELETE' }),

  getConversations: (q?: string) =>
    apiFetch<{ conversations: Conversation[] }>(`/api/v1/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createConversation: (data: { title?: string; projectId?: string | null; routingMode?: 'auto' | 'manual'; preferredModel?: string | null }) =>
    apiFetch<{ conversation: Conversation }>('/api/v1/conversations', { method: 'POST', body: JSON.stringify(data) }),
  getConversation: (id: string) =>
    apiFetch<{ conversation: Conversation }>(`/api/v1/conversations/${id}`),
  updateConversation: (id: string, data: Partial<Conversation>) =>
    apiFetch<{ conversation: Conversation }>(`/api/v1/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteConversation: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/conversations/${id}`, { method: 'DELETE' }),

  sendChat: (data: {
    conversationId?: string;
    projectId?: string | null;
    prompt: string;
    routingMode: 'auto' | 'manual';
    modelId?: string | null;
    useKnowledge?: boolean;
    attachment?: { fileName: string; mimeType: string; content: string };
  }) =>
    apiFetch<{
      conversationId: string;
      decision: RoutingDecision;
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
      creditsCharged: number;
    }>('/api/v1/chat', { method: 'POST', body: JSON.stringify({ ...data, stream: false }) }),

  async streamChat(
    data: {
      conversationId?: string;
      projectId?: string | null;
      prompt: string;
      routingMode: 'auto' | 'manual';
      modelId?: string | null;
      useKnowledge?: boolean;
      attachment?: { fileName: string; mimeType: string; content: string };
    },
    handlers: {
      signal?: AbortSignal;
      onMeta?: (meta: { conversationId: string; decision: RoutingDecision }) => void;
      onDelta?: (delta: string) => void;
      onDone?: (payload: { message: ChatMessage; creditsCharged: number }) => void;
      onError?: (message: string) => void;
    },
  ): Promise<void> {
    const token = getStoredToken();
    const base = (import.meta.env.VITE_API_URL as string | undefined) || '';
    const res = await fetch(`${base}/api/v1/chat`, {
      method: 'POST',
      signal: handlers.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...data, stream: true }),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      throw new ApiError(
        res.status,
        errJson?.error?.code || 'STREAM_ERROR',
        errJson?.error?.message || `HTTP ${res.status}`,
      );
    }

    if (!res.body) throw new Error('Empty stream response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        const lines = block.split('\n');
        let eventName = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine);
        if (eventName === 'meta') handlers.onMeta?.(parsed);
        else if (eventName === 'delta') handlers.onDelta?.(parsed.delta || '');
        else if (eventName === 'done') handlers.onDone?.(parsed);
        else if (eventName === 'error') handlers.onError?.(parsed.message || 'Upstream stream error');
      }
    }
  },

  getBrainLogs: () => apiFetch<{ logs: RoutingLog[] }>('/api/v1/brain/logs'),
  getBrainPolicies: () =>
    apiFetch<{
      policies: Array<{
        id: string;
        name: string;
        taskCategory: string;
        preferredModelId: string;
        fallbackModelId: string;
        maxCostTier: string;
        active: boolean;
      }>;
    }>('/api/v1/brain/policies'),

  getResearchReports: () => apiFetch<{ reports: ResearchReport[] }>('/api/v1/research'),
  runResearch: (query: string) =>
    apiFetch<{ report: ResearchReport }>('/api/v1/research', { method: 'POST', body: JSON.stringify({ query }) }),

  runCoder: (data: {
    taskType: 'generate' | 'explain' | 'debug' | 'refactor' | 'review';
    language: string;
    prompt: string;
    codeContext?: string;
  }) =>
    apiFetch<{
      output: string;
      decision: RoutingDecision;
      requiresHumanApprovalForExternalWrite: boolean;
      tokens: { input: number; output: number };
    }>('/api/v1/coder', { method: 'POST', body: JSON.stringify(data) }),

  getAgents: () => apiFetch<{ agents: AgentConfig[] }>('/api/v1/agents'),
  createAgent: (data: Omit<AgentConfig, 'id' | 'userId' | 'createdAt'>) =>
    apiFetch<{ agent: AgentConfig }>('/api/v1/agents', { method: 'POST', body: JSON.stringify(data) }),
  getAgentRuns: () => apiFetch<{ runs: AgentRun[] }>('/api/v1/agents/runs'),
  runAgent: (agentId: string, inputTask: string) =>
    apiFetch<{ run: AgentRun }>(`/api/v1/agents/${agentId}/run`, {
      method: 'POST',
      body: JSON.stringify({ inputTask }),
    }),
  decideApproval: (approvalId: string, decision: 'approved' | 'rejected') =>
    apiFetch<{ run: AgentRun }>(`/api/v1/agents/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
  cancelAgentRun: (runId: string) =>
    apiFetch<{ run: AgentRun }>(`/api/v1/agents/runs/${runId}/cancel`, { method: 'POST' }),

  getKnowledgeDocs: () => apiFetch<{ documents: KnowledgeDocument[] }>('/api/v1/knowledge/documents'),
  uploadKnowledgeDoc: (data: { fileName: string; mimeType: string; content: string }) =>
    apiFetch<{ document: KnowledgeDocument }>('/api/v1/knowledge/documents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteKnowledgeDoc: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/knowledge/documents/${id}`, { method: 'DELETE' }),
  searchKnowledge: (query: string) =>
    apiFetch<{ matches: KnowledgeChunkMatch[] }>('/api/v1/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),

  getMemories: () => apiFetch<{ consentEnabled: boolean; memories: UserMemory[] }>('/api/v1/memories'),
  addMemory: (fact: string) =>
    apiFetch<{ memory: UserMemory }>('/api/v1/memories', { method: 'POST', body: JSON.stringify({ fact }) }),
  deleteMemory: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/v1/memories/${id}`, { method: 'DELETE' }),

  getIntegrations: () => apiFetch<{ integrations: ConnectedAccount[] }>('/api/v1/integrations'),
  getUsage: () => apiFetch<{ usage: UsageSummary }>('/api/v1/usage'),

  // Admin Console Endpoints (Server RBAC Enforced)
  adminOverview: () =>
    apiFetch<{
      environment: string;
      totalUsers: number;
      totalConversations: number;
      totalProjects: number;
      totalAgents: number;
      totalRoutingLogs: number;
      totalUsageRecords: number;
      providers: Array<{ id: string; displayName: string; configured: boolean }>;
    }>('/api/v1/admin/overview'),
  adminUsers: () => apiFetch<{ users: Array<UserProfile & { creditBalance: number }> }>('/api/v1/admin/users'),
  adminUpdateRole: (userId: string, role: UserRole) =>
    apiFetch<{ user: UserProfile }>(`/api/v1/admin/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  adminAuditLogs: () =>
    apiFetch<{
      auditLogs: Array<{
        id: string;
        actorId: string;
        action: string;
        resourceType: string;
        resourceId: string | null;
        detail: string;
        createdAt: string;
      }>;
    }>('/api/v1/admin/audit-logs'),
  adminFlags: () =>
    apiFetch<{ flags: Array<{ key: string; enabled: boolean; description: string }> }>('/api/v1/admin/flags'),
  adminToggleFlag: (key: string, enabled: boolean) =>
    apiFetch<{ flag: { key: string; enabled: boolean; description: string } }>(`/api/v1/admin/flags/${key}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  adminUpdatePolicy: (id: string, patch: { active?: boolean; preferredModelId?: string; fallbackModelId?: string }) =>
    apiFetch<{ policy: unknown }>(`/api/v1/admin/policies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};
