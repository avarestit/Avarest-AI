import type {
  AgentApproval,
  AgentConfig,
  AgentRun,
  ChatMessage,
  Conversation,
  CreditExecutionFeature,
  CreditLedgerEntry,
  CreditReservation,
  KnowledgeChunkMatch,
  KnowledgeDocument,
  Project,
  ProviderId,
  ResearchReport,
  RoutingLog,
  UsageSummary,
  UserMemory,
  UserProfile,
  UserRole,
} from '../../shared/types.ts';
import { DEFAULT_ROUTING_POLICIES, type RoutingPolicyRule } from '../brain/router.ts';

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
  creditReservations: Map<string, CreditReservation>;
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
  return {
    users: new Map(),
    usersByEmail: new Map(),
    projects: new Map(),
    conversations: new Map(),
    messages: new Map(),
    routingPolicies: DEFAULT_ROUTING_POLICIES.map((p) => ({ ...p })),
    routingLogs: [],
    credits: new Map(),
    creditLedger: [],
    creditReservations: new Map(),
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
}

// Local staging/development process store ONLY; production refuses in-memory persistence.
export const defaultStore = createStore();

export function sanitizeUser(u: StoredUser): UserProfile {
  const { passwordHash: _ignored, ...profile } = u;
  return profile;
}

export function appendAuditLog(
  store: WorkspaceStore,
  entry: Omit<AuditLogEntry, 'id' | 'createdAt'>,
): AuditLogEntry {
  const full: AuditLogEntry = {
    id: crypto.randomUUID(),
    ...entry,
    createdAt: new Date().toISOString(),
  };
  store.auditLogs.unshift(full);
  if (store.auditLogs.length > 500) {
    store.auditLogs.length = 500;
  }
  return full;
}

function roundCredits(val: number): number {
  return Number(val.toFixed(4));
}

function appendLedgerEntryIdempotent(
  store: WorkspaceStore,
  entry: Omit<CreditLedgerEntry, 'id' | 'createdAt'>,
): void {
  if (entry.referenceId) {
    const exists = store.creditLedger.some(
      (l) => l.userId === entry.userId && l.referenceId === entry.referenceId,
    );
    if (exists) return;
  }
  store.creditLedger.unshift({
    id: crypto.randomUUID(),
    ...entry,
    createdAt: new Date().toISOString(),
  });
}

export function reconcileExpiredReservationsAtomic(
  store: WorkspaceStore,
  params?: { userId?: string; limit?: number },
): { reconciledCount: number; refundedTotal: number } {
  const nowMs = Date.now();
  const limit = Math.max(1, Math.min(params?.limit ?? 100, 1000));
  let reconciledCount = 0;
  let refundedTotal = 0;

  for (const res of store.creditReservations.values()) {
    if (reconciledCount >= limit) break;
    if (params?.userId && res.userId !== params.userId) continue;
    if (res.status !== 'reserved') continue;
    if (Date.parse(res.expiresAt) > nowMs) continue;

    const acct = store.credits.get(res.userId);
    if (!acct) continue;

    const nextBalance = roundCredits(acct.balance + res.reservedAmount);
    store.credits.set(res.userId, { ...acct, balance: nextBalance });

    const nowIso = new Date(nowMs).toISOString();
    res.status = 'expired';
    res.actualAmount = 0;
    res.releasedAt = nowIso;
    res.updatedAt = nowIso;

    appendLedgerEntryIdempotent(store, {
      userId: res.userId,
      delta: roundCredits(res.reservedAmount),
      balanceAfter: nextBalance,
      reason: `Expired reservation reconciled: ${res.reason}`,
      referenceId: `resv:${res.referenceId}:expire`,
    });

    reconciledCount += 1;
    refundedTotal = roundCredits(refundedTotal + res.reservedAmount);
  }

  return { reconciledCount, refundedTotal };
}

export function reserveCreditsAtomic(
  store: WorkspaceStore,
  params: {
    userId: string;
    amount: number;
    feature: CreditExecutionFeature;
    reason: string;
    referenceId: string;
    ttlSeconds?: number;
    providerId?: ProviderId;
    modelId?: string;
  },
): { reservation: CreditReservation; balanceAfter: number; deduplicated: boolean } {
  if (!params.referenceId || !params.referenceId.trim()) {
    throw new Error('INVALID_RESERVATION_REFERENCE');
  }
  const amount = roundCredits(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('INVALID_RESERVATION_AMOUNT');
  }

  const acct = store.credits.get(params.userId);
  if (!acct) {
    throw new Error('CREDIT_ACCOUNT_NOT_FOUND');
  }

  const key = `${params.userId}::${params.referenceId}`;
  const existing = store.creditReservations.get(key);
  if (existing) {
    return {
      reservation: { ...existing },
      balanceAfter: acct.balance,
      deduplicated: true,
    };
  }

  reconcileExpiredReservationsAtomic(store, { userId: params.userId });
  const freshAcct = store.credits.get(params.userId)!;

  if (freshAcct.balance < amount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }

  const nextBalance = roundCredits(freshAcct.balance - amount);
  if (nextBalance < 0) {
    throw new Error('INSUFFICIENT_CREDITS');
  }

  const ttlSeconds = Math.max(10, Math.min(params.ttlSeconds ?? 300, 3600));
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();

  store.credits.set(params.userId, { ...freshAcct, balance: nextBalance });

  const reservation: CreditReservation = {
    id: crypto.randomUUID(),
    userId: params.userId,
    referenceId: params.referenceId,
    feature: params.feature,
    providerId: params.providerId ?? null,
    modelId: params.modelId ?? null,
    reservedAmount: amount,
    actualAmount: 0,
    status: 'reserved',
    reason: params.reason,
    expiresAt,
    finalizedAt: null,
    releasedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  store.creditReservations.set(key, reservation);

  appendLedgerEntryIdempotent(store, {
    userId: params.userId,
    delta: -amount,
    balanceAfter: nextBalance,
    reason: `Reserved: ${params.reason}`,
    referenceId: `resv:${params.referenceId}:reserve`,
  });

  return {
    reservation: { ...reservation },
    balanceAfter: nextBalance,
    deduplicated: false,
  };
}

export function finalizeCreditReservationAtomic(
  store: WorkspaceStore,
  params: {
    userId: string;
    referenceId: string;
    actualAmount: number;
    reason?: string;
  },
): { reservation: CreditReservation; balanceAfter: number; deduplicated: boolean } {
  const actual = roundCredits(params.actualAmount);
  if (!Number.isFinite(actual) || actual < 0) {
    throw new Error('INVALID_FINALIZATION_AMOUNT');
  }

  const acct = store.credits.get(params.userId);
  if (!acct) {
    throw new Error('CREDIT_ACCOUNT_NOT_FOUND');
  }

  const key = `${params.userId}::${params.referenceId}`;
  const res = store.creditReservations.get(key);
  if (!res) {
    throw new Error('RESERVATION_NOT_FOUND');
  }

  if (res.status === 'finalized') {
    return {
      reservation: { ...res },
      balanceAfter: acct.balance,
      deduplicated: true,
    };
  }

  if (res.status === 'released' || res.status === 'expired') {
    throw new Error(`RESERVATION_NOT_ACTIVE:${res.status}`);
  }

  let nextBalance = acct.balance;
  let settledActual = actual;
  const label = (params.reason && params.reason.trim()) || res.reason;

  if (actual <= res.reservedAmount) {
    const refund = roundCredits(res.reservedAmount - actual);
    if (refund > 0) {
      nextBalance = roundCredits(acct.balance + refund);
      store.credits.set(params.userId, { ...acct, balance: nextBalance });
      appendLedgerEntryIdempotent(store, {
        userId: params.userId,
        delta: refund,
        balanceAfter: nextBalance,
        reason: `${label} (unused reservation released)`,
        referenceId: `resv:${params.referenceId}:release_unused`,
      });
    }
  } else {
    const extraNeeded = roundCredits(actual - res.reservedAmount);
    const collected = roundCredits(Math.min(acct.balance, extraNeeded));
    settledActual = roundCredits(res.reservedAmount + collected);
    if (collected > 0) {
      nextBalance = roundCredits(acct.balance - collected);
      store.credits.set(params.userId, { ...acct, balance: nextBalance });
      appendLedgerEntryIdempotent(store, {
        userId: params.userId,
        delta: -collected,
        balanceAfter: nextBalance,
        reason: `${label} (usage overage settled)`,
        referenceId: `resv:${params.referenceId}:overage`,
      });
    }
  }

  const nowIso = new Date().toISOString();
  res.status = 'finalized';
  res.actualAmount = settledActual;
  res.finalizedAt = nowIso;
  res.updatedAt = nowIso;

  return {
    reservation: { ...res },
    balanceAfter: nextBalance,
    deduplicated: false,
  };
}

export function releaseCreditReservationAtomic(
  store: WorkspaceStore,
  params: {
    userId: string;
    referenceId: string;
    reason?: string;
  },
): { reservation: CreditReservation; refundedAmount: number; balanceAfter: number; deduplicated: boolean } {
  const acct = store.credits.get(params.userId);
  if (!acct) {
    throw new Error('CREDIT_ACCOUNT_NOT_FOUND');
  }

  const key = `${params.userId}::${params.referenceId}`;
  const res = store.creditReservations.get(key);
  if (!res) {
    throw new Error('RESERVATION_NOT_FOUND');
  }

  if (res.status === 'released' || res.status === 'expired' || res.status === 'finalized') {
    return {
      reservation: { ...res },
      refundedAmount: 0,
      balanceAfter: acct.balance,
      deduplicated: true,
    };
  }

  const refundedAmount = roundCredits(res.reservedAmount);
  const nextBalance = roundCredits(acct.balance + refundedAmount);
  store.credits.set(params.userId, { ...acct, balance: nextBalance });

  const nowIso = new Date().toISOString();
  res.status = 'released';
  res.actualAmount = 0;
  res.releasedAt = nowIso;
  res.updatedAt = nowIso;

  appendLedgerEntryIdempotent(store, {
    userId: params.userId,
    delta: refundedAmount,
    balanceAfter: nextBalance,
    reason: (params.reason && params.reason.trim()) || `Released reservation: ${res.reason}`,
    referenceId: `resv:${params.referenceId}:release`,
  });

  return {
    reservation: { ...res },
    refundedAmount,
    balanceAfter: nextBalance,
    deduplicated: false,
  };
}

export function deductCreditsAtomic(
  store: WorkspaceStore,
  params: { userId: string; amount: number; reason: string; referenceId?: string },
): number {
  const acct = store.credits.get(params.userId);
  if (!acct) {
    throw new Error('CREDIT_ACCOUNT_NOT_FOUND');
  }
  if (params.amount <= 0) return acct.balance;

  // Idempotent guard: prevent duplicate deduction for the same referenceId
  if (params.referenceId) {
    const existing = store.creditLedger.find(
      (entry) => entry.userId === params.userId && entry.referenceId === params.referenceId,
    );
    if (existing) {
      return existing.balanceAfter;
    }
  }

  reconcileExpiredReservationsAtomic(store, { userId: params.userId });
  const freshAcct = store.credits.get(params.userId)!;

  if (freshAcct.balance < params.amount) {
    throw new Error('INSUFFICIENT_CREDITS');
  }

  const nextBalance = roundCredits(freshAcct.balance - params.amount);
  store.credits.set(params.userId, { ...freshAcct, balance: nextBalance });
  store.creditLedger.unshift({
    id: crypto.randomUUID(),
    userId: params.userId,
    delta: -roundCredits(params.amount),
    balanceAfter: nextBalance,
    reason: params.reason,
    referenceId: params.referenceId || null,
    createdAt: new Date().toISOString(),
  });
  return nextBalance;
}

export function getUserUsageSummary(store: WorkspaceStore, userId: string): UsageSummary {
  reconcileExpiredReservationsAtomic(store, { userId });
  const acct = store.credits.get(userId) || { balance: 0, monthlyAllowance: 100 };
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
