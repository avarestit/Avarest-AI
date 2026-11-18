import type {
  AgentApproval,
  AgentConfig,
  AgentRun,
  ChatMessage,
  Conversation,
  CreditExecutionFeature,
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
import type { RoutingPolicyRule } from '../brain/router.ts';
import {
  appendAuditLog,
  chunkTextDocument,
  deductCreditsAtomic,
  finalizeCreditReservationAtomic,
  getUserUsageSummary,
  isAdminRole,
  reconcileExpiredReservationsAtomic,
  releaseCreditReservationAtomic,
  reserveCreditsAtomic,
  sanitizeUser,
  searchUserChunks,
  type AuditLogEntry,
  type FeatureFlag,
  type StoredUser,
  type WorkspaceStore,
} from './store.ts';

export interface DatabasePingResult {
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

export interface WorkspaceRepository {
  readonly kind: 'memory' | 'supabase';

  pingDatabase(): Promise<DatabasePingResult>;

  // Auth & Profiles
  getUserById(userId: string): Promise<StoredUser | null>;
  getUserByEmail(email: string): Promise<StoredUser | null>;
  createLocalUser(user: StoredUser, initialCredits?: number): Promise<UserProfile>;
  upsertProfileFromSupabaseAuth(params: { id: string; email: string; fullName: string }): Promise<UserProfile>;
  updateProfile(
    userId: string,
    patch: Partial<Pick<UserProfile, 'fullName' | 'language' | 'experienceMode' | 'memoryConsent'>>,
  ): Promise<UserProfile | null>;
  countAdmins(): Promise<number>;
  updateUserRole(userId: string, role: UserRole): Promise<UserProfile | null>;
  bootstrapAdmin(params: {
    email: string;
    fullName?: string;
    passwordHash?: string;
    initialCredits?: number;
  }): Promise<UserProfile>;
  listUsersWithCredits(): Promise<Array<UserProfile & { creditBalance: number }>>;

  // Credits & Usage
  getCreditBalance(userId: string): Promise<number>;
  reserveCredits(params: {
    userId: string;
    amount: number;
    feature: CreditExecutionFeature;
    reason: string;
    referenceId: string;
    ttlSeconds?: number;
    providerId?: ProviderId;
    modelId?: string;
  }): Promise<{ reservation: CreditReservation; balanceAfter: number; deduplicated: boolean }>;
  finalizeCreditReservation(params: {
    userId: string;
    referenceId: string;
    actualAmount: number;
    reason?: string;
  }): Promise<{ reservation: CreditReservation; balanceAfter: number; deduplicated: boolean }>;
  releaseCreditReservation(params: {
    userId: string;
    referenceId: string;
    reason?: string;
  }): Promise<{ reservation: CreditReservation; refundedAmount: number; balanceAfter: number; deduplicated: boolean }>;
  reconcileExpiredReservations(params?: {
    userId?: string;
    limit?: number;
  }): Promise<{ reconciledCount: number; refundedTotal: number }>;
  listCreditReservations(userId: string, limit?: number): Promise<CreditReservation[]>;
  deductCredits(params: { userId: string; amount: number; reason: string; referenceId?: string }): Promise<number>;
  recordUsage(entry: {
    userId: string;
    providerId: string;
    modelId: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    creditsCharged: number;
  }): Promise<void>;
  getUserUsageSummary(userId: string): Promise<UsageSummary>;

  // Projects
  listProjects(userId: string): Promise<Project[]>;
  getProject(userId: string, id: string): Promise<Project | null>;
  createProject(userId: string, data: { name: string; description: string; instructions: string }): Promise<Project>;
  updateProject(userId: string, id: string, patch: Partial<Project>): Promise<Project | null>;
  deleteProject(userId: string, id: string): Promise<boolean>;

  // Conversations & Messages
  listConversations(userId: string, query?: string): Promise<Conversation[]>;
  getConversation(userId: string, id: string): Promise<(Conversation & { messages: ChatMessage[] }) | null>;
  createConversation(
    userId: string,
    data: {
      title: string;
      projectId: string | null;
      routingMode: 'auto' | 'manual';
      preferredModel: string | null;
    },
  ): Promise<Conversation>;
  updateConversation(userId: string, id: string, patch: Partial<Conversation>): Promise<Conversation | null>;
  deleteConversation(userId: string, id: string): Promise<boolean>;
  addMessage(userId: string, message: ChatMessage): Promise<ChatMessage>;

  // Routing Logs & Policies
  listRoutingLogs(userId: string, limit?: number): Promise<RoutingLog[]>;
  addRoutingLog(log: RoutingLog): Promise<void>;
  listRoutingPolicies(): Promise<RoutingPolicyRule[]>;
  updateRoutingPolicy(
    id: string,
    patch: { active?: boolean; preferredModelId?: string; fallbackModelId?: string },
  ): Promise<RoutingPolicyRule | null>;

  // Agents, Runs & Approvals
  listAgents(userId: string): Promise<AgentConfig[]>;
  getAgent(userId: string, id: string): Promise<AgentConfig | null>;
  createAgent(agent: AgentConfig): Promise<AgentConfig>;
  listAgentRuns(userId: string): Promise<AgentRun[]>;
  getAgentRun(userId: string, runId: string): Promise<AgentRun | null>;
  createAgentRun(run: AgentRun): Promise<AgentRun>;
  updateAgentRun(runId: string, patch: Partial<AgentRun>): Promise<AgentRun | null>;
  updateAgentRunConditional(
    runId: string,
    patch: Partial<AgentRun>,
    expectedStatus?: AgentRun['status'],
    userId?: string,
  ): Promise<AgentRun | null>;
  createApproval(approval: AgentApproval): Promise<AgentApproval>;
  getApproval(userId: string, approvalId: string): Promise<AgentApproval | null>;
  resolveApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    userId?: string,
  ): Promise<AgentApproval | null>;

  // Research
  listResearchReports(userId: string): Promise<ResearchReport[]>;
  createResearchReport(report: ResearchReport): Promise<ResearchReport>;

  // Knowledge & Memories
  listKnowledgeDocs(userId: string): Promise<KnowledgeDocument[]>;
  uploadKnowledgeDoc(params: {
    userId: string;
    fileName: string;
    mimeType: string;
    content: string;
  }): Promise<KnowledgeDocument>;
  deleteKnowledgeDoc(userId: string, id: string): Promise<boolean>;
  searchKnowledgeChunks(userId: string, query: string, limit?: number): Promise<KnowledgeChunkMatch[]>;
  listMemories(userId: string): Promise<UserMemory[]>;
  addMemory(userId: string, fact: string): Promise<UserMemory>;
  deleteMemory(userId: string, id: string): Promise<boolean>;

  // Admin & Audit
  getAdminOverview(): Promise<{
    totalUsers: number;
    totalConversations: number;
    totalProjects: number;
    totalAgents: number;
    totalRoutingLogs: number;
    totalUsageRecords: number;
  }>;
  listAuditLogs(limit?: number): Promise<AuditLogEntry[]>;
  appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void>;
  listFeatureFlags(): Promise<FeatureFlag[]>;
  toggleFeatureFlag(key: string, enabled: boolean): Promise<FeatureFlag | null>;
}

export class MemoryWorkspaceRepository implements WorkspaceRepository {
  readonly kind = 'memory' as const;
  private readonly store: WorkspaceStore;

  constructor(store: WorkspaceStore) {
    this.store = store;
  }

  async pingDatabase(): Promise<DatabasePingResult> {
    return { reachable: false, latencyMs: 0, error: 'Running in local in-memory staging sandbox (no PostgreSQL connected).' };
  }

  async getUserById(userId: string): Promise<StoredUser | null> {
    return this.store.users.get(userId) || null;
  }

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const id = this.store.usersByEmail.get(email.toLowerCase().trim());
    return id ? this.store.users.get(id) || null : null;
  }

  async createLocalUser(user: StoredUser, initialCredits = 100): Promise<UserProfile> {
    const normalizedEmail = user.email.toLowerCase().trim();
    const record: StoredUser = { ...user, email: normalizedEmail };
    this.store.users.set(record.id, record);
    this.store.usersByEmail.set(normalizedEmail, record.id);
    this.store.credits.set(record.id, { balance: initialCredits, monthlyAllowance: initialCredits });
    this.store.creditLedger.unshift({
      id: crypto.randomUUID(),
      userId: record.id,
      delta: initialCredits,
      balanceAfter: initialCredits,
      reason: 'Initial workspace credit grant',
      referenceId: null,
      createdAt: new Date().toISOString(),
    });
    return sanitizeUser(record);
  }

  async upsertProfileFromSupabaseAuth(params: { id: string; email: string; fullName: string }): Promise<UserProfile> {
    const existing = this.store.users.get(params.id);
    if (existing) return sanitizeUser(existing);
    return this.createLocalUser({
      id: params.id,
      email: params.email,
      fullName: params.fullName,
      role: 'user',
      language: 'en',
      experienceMode: 'beginner',
      memoryConsent: false,
      activePlan: 'free',
      createdAt: new Date().toISOString(),
      passwordHash: '',
    });
  }

  async updateProfile(
    userId: string,
    patch: Partial<Pick<UserProfile, 'fullName' | 'language' | 'experienceMode' | 'memoryConsent'>>,
  ): Promise<UserProfile | null> {
    const stored = this.store.users.get(userId);
    if (!stored) return null;
    if (patch.fullName !== undefined) stored.fullName = patch.fullName.trim();
    if (patch.language !== undefined) stored.language = patch.language;
    if (patch.experienceMode !== undefined) stored.experienceMode = patch.experienceMode;
    if (patch.memoryConsent !== undefined) stored.memoryConsent = patch.memoryConsent;
    return sanitizeUser(stored);
  }

  async countAdmins(): Promise<number> {
    return Array.from(this.store.users.values()).filter((u) => isAdminRole(u.role)).length;
  }

  async updateUserRole(userId: string, role: UserRole): Promise<UserProfile | null> {
    const stored = this.store.users.get(userId);
    if (!stored) return null;
    stored.role = role;
    return sanitizeUser(stored);
  }

  async bootstrapAdmin(params: {
    email: string;
    fullName?: string;
    passwordHash?: string;
    initialCredits?: number;
  }): Promise<UserProfile> {
    const existingAdmins = Array.from(this.store.users.values()).filter((u) => isAdminRole(u.role));
    if (existingAdmins.length > 0) {
      throw new Error('ADMIN_ALREADY_EXISTS');
    }
    const normalizedEmail = params.email.toLowerCase().trim();
    const existingId = this.store.usersByEmail.get(normalizedEmail);
    const existingUser = existingId ? this.store.users.get(existingId) : null;
    if (existingUser) {
      existingUser.role = 'super_admin';
      if (params.fullName) existingUser.fullName = params.fullName.trim();
      return sanitizeUser(existingUser);
    }
    const id = crypto.randomUUID();
    const credits = params.initialCredits ?? 1000;
    const created: StoredUser = {
      id,
      email: normalizedEmail,
      fullName: params.fullName?.trim() || 'Platform Administrator',
      role: 'super_admin',
      language: 'en',
      experienceMode: 'advanced',
      memoryConsent: false,
      activePlan: 'enterprise',
      createdAt: new Date().toISOString(),
      passwordHash: params.passwordHash || '',
    };
    this.store.users.set(id, created);
    this.store.usersByEmail.set(normalizedEmail, id);
    this.store.credits.set(id, { balance: credits, monthlyAllowance: credits });
    this.store.creditLedger.unshift({
      id: crypto.randomUUID(),
      userId: id,
      delta: credits,
      balanceAfter: credits,
      reason: 'Initial admin bootstrap credit grant',
      referenceId: `bootstrap:${id}`,
      createdAt: new Date().toISOString(),
    });
    return sanitizeUser(created);
  }

  async listUsersWithCredits(): Promise<Array<UserProfile & { creditBalance: number }>> {
    return Array.from(this.store.users.values()).map((u) => ({
      ...sanitizeUser(u),
      creditBalance: this.store.credits.get(u.id)?.balance ?? 0,
    }));
  }

  async getCreditBalance(userId: string): Promise<number> {
    reconcileExpiredReservationsAtomic(this.store, { userId });
    return this.store.credits.get(userId)?.balance ?? 0;
  }

  async reserveCredits(params: {
    userId: string;
    amount: number;
    feature: CreditExecutionFeature;
    reason: string;
    referenceId: string;
    ttlSeconds?: number;
    providerId?: ProviderId;
    modelId?: string;
  }): Promise<{ reservation: CreditReservation; balanceAfter: number; deduplicated: boolean }> {
    return reserveCreditsAtomic(this.store, params);
  }

  async finalizeCreditReservation(params: {
    userId: string;
    referenceId: string;
    actualAmount: number;
    reason?: string;
  }): Promise<{ reservation: CreditReservation; balanceAfter: number; deduplicated: boolean }> {
    return finalizeCreditReservationAtomic(this.store, params);
  }

  async releaseCreditReservation(params: {
    userId: string;
    referenceId: string;
    reason?: string;
  }): Promise<{ reservation: CreditReservation; refundedAmount: number; balanceAfter: number; deduplicated: boolean }> {
    return releaseCreditReservationAtomic(this.store, params);
  }

  async reconcileExpiredReservations(params?: {
    userId?: string;
    limit?: number;
  }): Promise<{ reconciledCount: number; refundedTotal: number }> {
    return reconcileExpiredReservationsAtomic(this.store, params);
  }

  async listCreditReservations(userId: string, limit = 50): Promise<CreditReservation[]> {
    return Array.from(this.store.creditReservations.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async deductCredits(params: { userId: string; amount: number; reason: string; referenceId?: string }): Promise<number> {
    return deductCreditsAtomic(this.store, params);
  }

  async recordUsage(entry: {
    userId: string;
    providerId: string;
    modelId: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    creditsCharged: number;
  }): Promise<void> {
    this.store.usageRecords.push({
      id: crypto.randomUUID(),
      ...entry,
      createdAt: new Date().toISOString(),
    });
  }

  async getUserUsageSummary(userId: string): Promise<UsageSummary> {
    return getUserUsageSummary(this.store, userId);
  }

  async listProjects(userId: string): Promise<Project[]> {
    return Array.from(this.store.projects.values())
      .filter((p) => p.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(userId: string, id: string): Promise<Project | null> {
    const p = this.store.projects.get(id);
    return p && p.userId === userId ? p : null;
  }

  async createProject(userId: string, data: { name: string; description: string; instructions: string }): Promise<Project> {
    const now = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      userId,
      name: data.name.trim(),
      description: data.description.trim(),
      instructions: data.instructions.trim(),
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.projects.set(project.id, project);
    return project;
  }

  async updateProject(userId: string, id: string, patch: Partial<Project>): Promise<Project | null> {
    const existing = this.store.projects.get(id);
    if (!existing || existing.userId !== userId) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) existing.name = patch.name.trim();
    if (typeof patch.description === 'string') existing.description = patch.description.trim();
    if (typeof patch.instructions === 'string') existing.instructions = patch.instructions.trim();
    if (typeof patch.archived === 'boolean') existing.archived = patch.archived;
    existing.updatedAt = new Date().toISOString();
    return existing;
  }

  async deleteProject(userId: string, id: string): Promise<boolean> {
    const existing = this.store.projects.get(id);
    if (!existing || existing.userId !== userId) return false;
    this.store.projects.delete(id);
    return true;
  }

  async listConversations(userId: string, query?: string): Promise<Conversation[]> {
    const q = (query || '').toLowerCase().trim();
    return Array.from(this.store.conversations.values())
      .filter((c) => c.userId === userId && (!q || c.title.toLowerCase().includes(q)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(userId: string, id: string): Promise<(Conversation & { messages: ChatMessage[] }) | null> {
    const conv = this.store.conversations.get(id);
    if (!conv || conv.userId !== userId) return null;
    return { ...conv, messages: [...(this.store.messages.get(id) || [])] };
  }

  async createConversation(
    userId: string,
    data: {
      title: string;
      projectId: string | null;
      routingMode: 'auto' | 'manual';
      preferredModel: string | null;
    },
  ): Promise<Conversation> {
    const now = new Date().toISOString();
    const conv: Conversation = {
      id: crypto.randomUUID(),
      userId,
      projectId: data.projectId,
      title: data.title,
      routingMode: data.routingMode,
      preferredModel: data.preferredModel,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.conversations.set(conv.id, conv);
    this.store.messages.set(conv.id, []);
    return conv;
  }

  async updateConversation(userId: string, id: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const conv = this.store.conversations.get(id);
    if (!conv || conv.userId !== userId) return null;
    if (typeof patch.title === 'string' && patch.title.trim()) conv.title = patch.title.trim().slice(0, 120);
    if (typeof patch.archived === 'boolean') conv.archived = patch.archived;
    if (patch.routingMode === 'auto' || patch.routingMode === 'manual') conv.routingMode = patch.routingMode;
    if (patch.preferredModel === null || typeof patch.preferredModel === 'string') conv.preferredModel = patch.preferredModel;
    conv.updatedAt = new Date().toISOString();
    return conv;
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    const conv = this.store.conversations.get(id);
    if (!conv || conv.userId !== userId) return false;
    this.store.conversations.delete(id);
    this.store.messages.delete(id);
    return true;
  }

  async addMessage(userId: string, message: ChatMessage): Promise<ChatMessage> {
    const conv = this.store.conversations.get(message.conversationId);
    if (!conv || conv.userId !== userId) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }
    const list = this.store.messages.get(message.conversationId) || [];
    list.push(message);
    this.store.messages.set(message.conversationId, list);
    conv.updatedAt = new Date().toISOString();
    return message;
  }

  async listRoutingLogs(userId: string, limit = 50): Promise<RoutingLog[]> {
    return this.store.routingLogs.filter((l) => l.userId === userId).slice(0, limit);
  }

  async addRoutingLog(log: RoutingLog): Promise<void> {
    this.store.routingLogs.unshift(log);
  }

  async listRoutingPolicies(): Promise<RoutingPolicyRule[]> {
    return this.store.routingPolicies;
  }

  async updateRoutingPolicy(
    id: string,
    patch: { active?: boolean; preferredModelId?: string; fallbackModelId?: string },
  ): Promise<RoutingPolicyRule | null> {
    const policy = this.store.routingPolicies.find((p) => p.id === id);
    if (!policy) return null;
    if (typeof patch.active === 'boolean') policy.active = patch.active;
    if (typeof patch.preferredModelId === 'string') policy.preferredModelId = patch.preferredModelId;
    if (typeof patch.fallbackModelId === 'string') policy.fallbackModelId = patch.fallbackModelId;
    return policy;
  }

  async listAgents(userId: string): Promise<AgentConfig[]> {
    return Array.from(this.store.agents.values()).filter((a) => a.userId === userId);
  }

  async getAgent(userId: string, id: string): Promise<AgentConfig | null> {
    const a = this.store.agents.get(id);
    return a && a.userId === userId ? a : null;
  }

  async createAgent(agent: AgentConfig): Promise<AgentConfig> {
    this.store.agents.set(agent.id, agent);
    return agent;
  }

  async listAgentRuns(userId: string): Promise<AgentRun[]> {
    return Array.from(this.store.agentRuns.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => {
        const pendingApproval = Array.from(this.store.agentApprovals.values()).find(
          (ap) => ap.runId === run.id && ap.decision === 'pending',
        );
        return { ...run, pendingApproval: pendingApproval || null };
      });
  }

  async getAgentRun(userId: string, runId: string): Promise<AgentRun | null> {
    const run = this.store.agentRuns.get(runId);
    return run && run.userId === userId ? run : null;
  }

  async createAgentRun(run: AgentRun): Promise<AgentRun> {
    this.store.agentRuns.set(run.id, run);
    return run;
  }

  async updateAgentRun(runId: string, patch: Partial<AgentRun>): Promise<AgentRun | null> {
    const run = this.store.agentRuns.get(runId);
    if (!run) return null;
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    return run;
  }

  async updateAgentRunConditional(
    runId: string,
    patch: Partial<AgentRun>,
    expectedStatus?: AgentRun['status'],
    userId?: string,
  ): Promise<AgentRun | null> {
    const run = this.store.agentRuns.get(runId);
    if (!run) return null;
    if (userId && run.userId !== userId) return null;
    if (expectedStatus && run.status !== expectedStatus) return null;
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    return { ...run };
  }

  async createApproval(approval: AgentApproval): Promise<AgentApproval> {
    this.store.agentApprovals.set(approval.id, approval);
    return approval;
  }

  async getApproval(userId: string, approvalId: string): Promise<AgentApproval | null> {
    const ap = this.store.agentApprovals.get(approvalId);
    return ap && ap.userId === userId ? ap : null;
  }

  async resolveApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    userId?: string,
  ): Promise<AgentApproval | null> {
    const ap = this.store.agentApprovals.get(approvalId);
    if (!ap || (userId && ap.userId !== userId) || ap.decision !== 'pending') return null;
    ap.decision = decision;
    ap.decidedAt = new Date().toISOString();
    return ap;
  }

  async listResearchReports(userId: string): Promise<ResearchReport[]> {
    return Array.from(this.store.researchReports.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createResearchReport(report: ResearchReport): Promise<ResearchReport> {
    this.store.researchReports.set(report.id, report);
    return report;
  }

  async listKnowledgeDocs(userId: string): Promise<KnowledgeDocument[]> {
    return Array.from(this.store.knowledgeDocs.values()).filter((d) => d.userId === userId);
  }

  async uploadKnowledgeDoc(params: {
    userId: string;
    fileName: string;
    mimeType: string;
    content: string;
  }): Promise<KnowledgeDocument> {
    const chunks = chunkTextDocument(params.content);
    const docId = crypto.randomUUID();
    const doc: KnowledgeDocument = {
      id: docId,
      userId: params.userId,
      fileName: params.fileName.trim(),
      mimeType: params.mimeType,
      byteSize: new TextEncoder().encode(params.content).length,
      chunkCount: chunks.length,
      storagePath: null,
      retrievalMode: 'keyword_rank',
      createdAt: new Date().toISOString(),
    };
    this.store.knowledgeDocs.set(docId, doc);
    chunks.forEach((content, idx) => {
      this.store.knowledgeChunks.push({
        id: crypto.randomUUID(),
        documentId: docId,
        userId: params.userId,
        fileName: doc.fileName,
        chunkIndex: idx,
        content,
      });
    });
    return doc;
  }

  async deleteKnowledgeDoc(userId: string, id: string): Promise<boolean> {
    const doc = this.store.knowledgeDocs.get(id);
    if (!doc || doc.userId !== userId) return false;
    this.store.knowledgeDocs.delete(id);
    this.store.knowledgeChunks = this.store.knowledgeChunks.filter((ch) => ch.documentId !== id);
    return true;
  }

  async searchKnowledgeChunks(userId: string, query: string, limit = 5): Promise<KnowledgeChunkMatch[]> {
    return searchUserChunks(this.store, userId, query, limit);
  }

  async listMemories(userId: string): Promise<UserMemory[]> {
    return this.store.memories.get(userId) || [];
  }

  async addMemory(userId: string, fact: string): Promise<UserMemory> {
    const existing = this.store.memories.get(userId) || [];
    const mem: UserMemory = {
      id: crypto.randomUUID(),
      userId,
      fact,
      source: 'user',
      createdAt: new Date().toISOString(),
    };
    existing.unshift(mem);
    this.store.memories.set(userId, existing);
    return mem;
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    const existing = this.store.memories.get(userId) || [];
    const next = existing.filter((m) => m.id !== id);
    this.store.memories.set(userId, next);
    return next.length !== existing.length;
  }

  async getAdminOverview() {
    return {
      totalUsers: this.store.users.size,
      totalConversations: this.store.conversations.size,
      totalProjects: this.store.projects.size,
      totalAgents: this.store.agents.size,
      totalRoutingLogs: this.store.routingLogs.length,
      totalUsageRecords: this.store.usageRecords.length,
    };
  }

  async listAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    return this.store.auditLogs.slice(0, limit);
  }

  async appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    appendAuditLog(this.store, entry);
  }

  async listFeatureFlags(): Promise<FeatureFlag[]> {
    return Array.from(this.store.featureFlags.values());
  }

  async toggleFeatureFlag(key: string, enabled: boolean): Promise<FeatureFlag | null> {
    const flag = this.store.featureFlags.get(key);
    if (!flag) return null;
    flag.enabled = enabled;
    return flag;
  }
}
