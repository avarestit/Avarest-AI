import type {
  AgentApproval,
  AgentConfig,
  AgentRun,
  ChatMessage,
  Conversation,
  CreditLedgerEntry,
  KnowledgeChunkMatch,
  KnowledgeDocument,
  Project,
  ResearchReport,
  RoutingLog,
  UsageSummary,
  UserMemory,
  UserProfile,
  UserRole,
} from '../../shared/types.ts';
import { DEFAULT_ROUTING_POLICIES, type RoutingPolicyRule } from '../brain/router.ts';
import { hashPassword } from './crypto.ts';

export interface StoredUser extends UserProfile {
  passwordHash: string;
}

export interface StoredChunk {
  id: string;
  documentId: string;
  userId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: string;
  createdAt: string;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
}

export interface WorkspaceStore {
  users: Map<string, StoredUser>;
  usersByEmail: Map<string, string>;
  projects: Map<string, Project>;
  conversations: Map<string, Conversation>;
  messages: Map<string, ChatMessage[]>;
  routingPolicies: RoutingPolicyRule[];
  routingLogs: RoutingLog[];
  credits: Map<string, { balance: number; monthlyAllowance: number }>;
  creditLedger: CreditLedgerEntry[];
  usageRecords: Array<{
    id: string;
    userId: string;
    providerId: string;
    modelId: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    creditsCharged: number;
    createdAt: string;
  }>;
  agents: Map<string, AgentConfig>;
  agentRuns: Map<string, AgentRun>;
  agentApprovals: Map<string, AgentApproval>;
  researchReports: Map<string, ResearchReport>;
  knowledgeDocs: Map<string, KnowledgeDocument>;
  knowledgeChunks: StoredChunk[];
  memories: Map<string, UserMemory[]>;
  auditLogs: AuditLogEntry[];
  featureFlags: Map<string, FeatureFlag>;
}

const DEFAULT_FLAGS: FeatureFlag[] = [
  { key: 'streaming_chat', enabled: true, description: 'Enable Server-Sent Events streaming in AI Chat' },
  { key: 'model_comparison', enabled: true, description: 'Allow side-by-side comparison of configured models' },
  { key: 'deep_research_grounding', enabled: true, description: 'Use Google Search Grounding for Deep Research when Gemini is configured' },
  { key: 'human_approval_checkpoints', enabled: true, description: 'Require explicit user approval for sensitive agent actions' },
  { key: 'live_billing_checkout', enabled: false, description: 'Disabled until payment processor credentials are approved' },
];

export function createStore(): WorkspaceStore {
  const store: WorkspaceStore = {
    users: new Map(),
    usersByEmail: new Map(),
    projects: new Map(),
    conversations: new Map(),
    messages: new Map(),
    routingPolicies: DEFAULT_ROUTING_POLICIES.map((p) => ({ ...p })),
    routingLogs: [],
    credits: new Map(),
    creditLedger: [],
    usageRecords: [],
    agents: new Map(),
    agentRuns: new Map(),
    agentApprovals: new Map(),
    researchReports: new Map(),
    knowledgeDocs: new Map(),
    knowledgeChunks: [],
    memories: new Map(),
    auditLogs: [],
    featureFlags: new Map(DEFAULT_FLAGS.map((f) => [f.key, { ...f }])),
  };

  return store;
}

// Singleton workspace store for the running process; tests can instantiate isolated stores via createStore()
export const defaultStore = createStore();

let seeded = false;
export async function ensureSeededSandboxAccounts(store: WorkspaceStore = defaultStore): Promise<void> {
  if (seeded && store.users.size > 0) return;

  if (!store.usersByEmail.has('admin@avarestai.com')) {
    const adminId = '00000000-0000-4000-8000-000000000001';
    const adminHash = await hashPassword('AvarestAdmin#2026');
    store.users.set(adminId, {
      id: adminId,
      email: 'admin@avarestai.com',
      fullName: 'Avarest Platform Admin',
      role: 'super_admin',
      language: 'en',
      experienceMode: 'advanced',
      memoryConsent: false,
      activePlan: 'enterprise',
      createdAt: new Date().toISOString(),
      passwordHash: adminHash,
    });
    store.usersByEmail.set('admin@avarestai.com', adminId);
    store.credits.set(adminId, { balance: 1000, monthlyAllowance: 1000 });
  }

  if (!store.usersByEmail.has('user@avarestai.com')) {
    const userId = '00000000-0000-4000-8000-000000000002';
    const userHash = await hashPassword('AvarestUser#2026');
    store.users.set(userId, {
      id: userId,
      email: 'user@avarestai.com',
      fullName: 'Demo Workspace User',
      role: 'user',
      language: 'en',
      experienceMode: 'beginner',
      memoryConsent: false,
      activePlan: 'free',
      createdAt: new Date().toISOString(),
      passwordHash: userHash,
    });
    store.usersByEmail.set('user@avarestai.com', userId);
    store.credits.set(userId, { balance: 100, monthlyAllowance: 100 });
  }

  seeded = true;
}

export function sanitizeUser(u: StoredUser): UserProfile {
  const { passwordHash: _ignored, ...profile } = u;
  return profile;
}

export function appendAuditLog(
  store: WorkspaceStore,
  entry: Omit<AuditLogEntry, 'id' | 'createdAt'>,
): void {
  store.auditLogs.unshift({
    id: crypto.randomUUID(),
    ...entry,
    createdAt: new Date().toISOString(),
  });
  if (store.auditLogs.length > 500) {
    store.auditLogs.length = 500;
  }
}

export function deductCreditsAtomic(
  store: WorkspaceStore,
  params: { userId: string; amount: number; reason: string; referenceId?: string },
): number {
  const acct = store.credits.get(params.userId) || { balance: 100, monthlyAllowance: 100 };
  if (params.amount <= 0) return acct.balance;
  if (acct.balance < params.amount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }
  const nextBalance = Number((acct.balance - params.amount).toFixed(4));
  store.credits.set(params.userId, { ...acct, balance: nextBalance });
  store.creditLedger.unshift({
    id: crypto.randomUUID(),
    userId: params.userId,
    delta: -params.amount,
    balanceAfter: nextBalance,
    reason: params.reason,
    referenceId: params.referenceId || null,
    createdAt: new Date().toISOString(),
  });
  return nextBalance;
}

export function getUserUsageSummary(store: WorkspaceStore, userId: string): UsageSummary {
  const acct = store.credits.get(userId) || { balance: 100, monthlyAllowance: 100 };
  const userRecords = store.usageRecords.filter((r) => r.userId === userId);
  const ledger = store.creditLedger.filter((l) => l.userId === userId).slice(0, 50);

  return {
    balance: acct.balance,
    monthlyAllowance: acct.monthlyAllowance,
    totalRequests: userRecords.length,
    totalInputTokens: userRecords.reduce((acc, r) => acc + r.inputTokens, 0),
    totalOutputTokens: userRecords.reduce((acc, r) => acc + r.outputTokens, 0),
    ledger,
  };
}

export function chunkTextDocument(text: string, chunkSize = 700, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const end = Math.min(clean.length, cursor + chunkSize);
    chunks.push(clean.slice(cursor, end).trim());
    if (end >= clean.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks;
}

export function searchUserChunks(
  store: WorkspaceStore,
  userId: string,
  query: string,
  limit = 5,
): KnowledgeChunkMatch[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9\u0980-\u09ff]+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const userChunks = store.knowledgeChunks.filter((c) => c.userId === userId);
  const scored: KnowledgeChunkMatch[] = [];

  for (const chunk of userChunks) {
    const lower = chunk.content.toLowerCase();
    let hits = 0;
    for (const term of terms) {
      if (lower.includes(term)) hits += 1;
    }
    if (hits > 0) {
      scored.push({
        documentId: chunk.documentId,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: Number((hits / terms.length).toFixed(3)),
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function isAdminRole(role: UserRole): boolean {
  return role === 'admin' || role === 'super_admin';
}
