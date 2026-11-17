import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentApproval,
  AgentConfig,
  AgentRun,
  ChatMessage,
  Conversation,
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
import type { DatabasePingResult, WorkspaceRepository } from './repository.ts';
import { chunkTextDocument, type AuditLogEntry, type FeatureFlag, type StoredUser } from './store.ts';

const KNOWLEDGE_BUCKET = 'knowledge-documents';

export class SupabaseWorkspaceRepository implements WorkspaceRepository {
  readonly kind = 'supabase' as const;
  private readonly db: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.db = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async pingDatabase(): Promise<DatabasePingResult> {
    const started = Date.now();
    try {
      const { error } = await this.db.from('feature_flags').select('key').limit(1);
      const latencyMs = Date.now() - started;
      if (error) {
        return { reachable: false, latencyMs, error: error.message };
      }
      return { reachable: true, latencyMs };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : 'Database connection check failed.',
      };
    }
  }

  private mapProfileRow(row: Record<string, unknown>): UserProfile {
    return {
      id: String(row.id),
      email: String(row.email || ''),
      fullName: String(row.full_name || ''),
      role: (row.role as UserRole) || 'user',
      language: (row.language as UserProfile['language']) || 'en',
      experienceMode: (row.experience_mode as UserProfile['experienceMode']) || 'beginner',
      memoryConsent: Boolean(row.memory_consent),
      activePlan: (row.active_plan as UserProfile['activePlan']) || 'free',
      createdAt: String(row.created_at || new Date().toISOString()),
    };
  }

  async getUserById(userId: string): Promise<StoredUser | null> {
    const { data, error } = await this.db.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error || !data) return null;
    return { ...this.mapProfileRow(data), passwordHash: '' };
  }

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const { data, error } = await this.db
      .from('profiles')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();
    if (error || !data) return null;
    return { ...this.mapProfileRow(data), passwordHash: '' };
  }

  async createLocalUser(): Promise<UserProfile> {
    throw new Error('USE_SUPABASE_AUTH_FOR_USER_CREATION');
  }

  async upsertProfileFromSupabaseAuth(params: { id: string; email: string; fullName: string }): Promise<UserProfile> {
    const existing = await this.getUserById(params.id);
    if (existing) {
      const { passwordHash: _ignored, ...profile } = existing;
      return profile;
    }

    const { data, error } = await this.db
      .from('profiles')
      .upsert(
        {
          id: params.id,
          email: params.email.toLowerCase().trim(),
          full_name: params.fullName.trim() || params.email,
          role: 'user',
          active_plan: 'free',
        },
        { onConflict: 'id' },
      )
      .select('*')
      .single();

    if (error || !data) {
      throw new Error(error?.message || 'Unable to provision Supabase profile.');
    }

    await this.db
      .from('credit_accounts')
      .upsert({ user_id: params.id, balance: 100, monthly_allowance: 100 }, { onConflict: 'user_id' });

    return this.mapProfileRow(data);
  }

  async updateProfile(
    userId: string,
    patch: Partial<Pick<UserProfile, 'fullName' | 'language' | 'experienceMode' | 'memoryConsent'>>,
  ): Promise<UserProfile | null> {
    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.fullName !== undefined) updatePayload.full_name = patch.fullName.trim();
    if (patch.language !== undefined) updatePayload.language = patch.language;
    if (patch.experienceMode !== undefined) updatePayload.experience_mode = patch.experienceMode;
    if (patch.memoryConsent !== undefined) updatePayload.memory_consent = patch.memoryConsent;

    const { data, error } = await this.db.from('profiles').update(updatePayload).eq('id', userId).select('*').maybeSingle();
    if (error || !data) return null;
    return this.mapProfileRow(data);
  }

  async countAdmins(): Promise<number> {
    const { count, error } = await this.db
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .in('role', ['admin', 'super_admin']);
    if (error) return 0;
    return count ?? 0;
  }

  async updateUserRole(userId: string, role: UserRole): Promise<UserProfile | null> {
    const { data, error } = await this.db
      .from('profiles')
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .select('*')
      .maybeSingle();
    if (error || !data) return null;
    return this.mapProfileRow(data);
  }

  async listUsersWithCredits(): Promise<Array<UserProfile & { creditBalance: number }>> {
    const { data: profiles } = await this.db.from('profiles').select('*').order('created_at', { ascending: false });
    const { data: accounts } = await this.db.from('credit_accounts').select('user_id, balance');
    const balMap = new Map<string, number>();
    for (const acct of accounts || []) {
      balMap.set(String(acct.user_id), Number(acct.balance ?? 0));
    }
    return (profiles || []).map((row) => {
      const p = this.mapProfileRow(row);
      return { ...p, creditBalance: balMap.get(p.id) ?? 0 };
    });
  }

  async getCreditBalance(userId: string): Promise<number> {
    const { data } = await this.db.from('credit_accounts').select('balance').eq('user_id', userId).maybeSingle();
    return Number(data?.balance ?? 0);
  }

  async deductCredits(params: { userId: string; amount: number; reason: string; referenceId?: string }): Promise<number> {
    const { data, error } = await this.db.rpc('deduct_credits', {
      p_user_id: params.userId,
      p_amount: params.amount,
      p_reason: params.reason,
      p_ref: params.referenceId || null,
    });
    if (error) {
      if (error.message.toLowerCase().includes('insufficient')) {
        throw new Error('INSUFFICIENT_CREDITS');
      }
      throw new Error(error.message);
    }
    return Number(data ?? 0);
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
    await this.db.from('usage_records').insert({
      user_id: entry.userId,
      provider_id: entry.providerId,
      model_id: entry.modelId,
      feature: entry.feature,
      input_tokens: entry.inputTokens,
      output_tokens: entry.outputTokens,
      credits_charged: entry.creditsCharged,
    });
  }

  async getUserUsageSummary(userId: string): Promise<UsageSummary> {
    const [{ data: acct }, { data: usageRows }, { data: ledgerRows }] = await Promise.all([
      this.db.from('credit_accounts').select('balance, monthly_allowance').eq('user_id', userId).maybeSingle(),
      this.db.from('usage_records').select('input_tokens, output_tokens').eq('user_id', userId),
      this.db
        .from('credit_ledger')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    return {
      balance: Number(acct?.balance ?? 0),
      monthlyAllowance: Number(acct?.monthly_allowance ?? 100),
      totalRequests: (usageRows || []).length,
      totalInputTokens: (usageRows || []).reduce((acc, r) => acc + Number(r.input_tokens || 0), 0),
      totalOutputTokens: (usageRows || []).reduce((acc, r) => acc + Number(r.output_tokens || 0), 0),
      ledger: (ledgerRows || []).map((l) => ({
        id: String(l.id),
        userId: String(l.user_id),
        delta: Number(l.delta),
        balanceAfter: Number(l.balance_after),
        reason: String(l.reason),
        referenceId: l.reference_id ? String(l.reference_id) : null,
        createdAt: String(l.created_at),
      })),
    };
  }

  private mapProjectRow(r: Record<string, unknown>): Project {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      name: String(r.name),
      description: String(r.description || ''),
      instructions: String(r.instructions || ''),
      archived: Boolean(r.archived),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async listProjects(userId: string): Promise<Project[]> {
    const { data } = await this.db
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    return (data || []).map((r) => this.mapProjectRow(r));
  }

  async getProject(userId: string, id: string): Promise<Project | null> {
    const { data } = await this.db.from('projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    return data ? this.mapProjectRow(data) : null;
  }

  async createProject(userId: string, data: { name: string; description: string; instructions: string }): Promise<Project> {
    const { data: row, error } = await this.db
      .from('projects')
      .insert({
        user_id: userId,
        name: data.name.trim(),
        description: data.description.trim(),
        instructions: data.instructions.trim(),
      })
      .select('*')
      .single();
    if (error || !row) throw new Error(error?.message || 'Failed to create project.');
    return this.mapProjectRow(row);
  }

  async updateProject(userId: string, id: string, patch: Partial<Project>): Promise<Project | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof patch.name === 'string' && patch.name.trim()) payload.name = patch.name.trim();
    if (typeof patch.description === 'string') payload.description = patch.description.trim();
    if (typeof patch.instructions === 'string') payload.instructions = patch.instructions.trim();
    if (typeof patch.archived === 'boolean') payload.archived = patch.archived;

    const { data } = await this.db
      .from('projects')
      .update(payload)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();
    return data ? this.mapProjectRow(data) : null;
  }

  async deleteProject(userId: string, id: string): Promise<boolean> {
    const { error, count } = await this.db
      .from('projects')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);
    return !error && (count ?? 0) > 0;
  }

  private mapConversationRow(r: Record<string, unknown>): Conversation {
    return {
      id: String(r.id),
      userId: String(r.user_id),
      projectId: r.project_id ? String(r.project_id) : null,
      title: String(r.title || 'New Conversation'),
      routingMode: r.routing_mode === 'manual' ? 'manual' : 'auto',
      preferredModel: r.preferred_model ? String(r.preferred_model) : null,
      archived: Boolean(r.archived),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async listConversations(userId: string, query?: string): Promise<Conversation[]> {
    let builder = this.db.from('conversations').select('*').eq('user_id', userId).order('updated_at', { ascending: false });
    if (query && query.trim()) {
      builder = builder.ilike('title', `%${query.trim()}%`);
    }
    const { data } = await builder;
    return (data || []).map((r) => this.mapConversationRow(r));
  }

  async getConversation(userId: string, id: string): Promise<(Conversation & { messages: ChatMessage[] }) | null> {
    const { data: conv } = await this.db
      .from('conversations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!conv) return null;

    const { data: msgs } = await this.db
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    return {
      ...this.mapConversationRow(conv),
      messages: (msgs || []).map((m) => ({
        id: String(m.id),
        conversationId: String(m.conversation_id),
        role: m.role as ChatMessage['role'],
        content: String(m.content),
        providerId: (m.provider_id as ChatMessage['providerId']) || null,
        modelId: m.model_id ? String(m.model_id) : null,
        taskCategory: (m.task_category as ChatMessage['taskCategory']) || null,
        routingReason: m.routing_reason ? String(m.routing_reason) : null,
        inputTokens: Number(m.input_tokens || 0),
        outputTokens: Number(m.output_tokens || 0),
        citations: Array.isArray(m.citations) ? m.citations : [],
        createdAt: String(m.created_at),
      })),
    };
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
    const { data: row, error } = await this.db
      .from('conversations')
      .insert({
        user_id: userId,
        project_id: data.projectId,
        title: data.title,
        routing_mode: data.routingMode,
        preferred_model: data.preferredModel,
      })
      .select('*')
      .single();
    if (error || !row) throw new Error(error?.message || 'Failed to create conversation.');
    return this.mapConversationRow(row);
  }

  async updateConversation(userId: string, id: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof patch.title === 'string' && patch.title.trim()) payload.title = patch.title.trim().slice(0, 120);
    if (typeof patch.archived === 'boolean') payload.archived = patch.archived;
    if (patch.routingMode === 'auto' || patch.routingMode === 'manual') payload.routing_mode = patch.routingMode;
    if (patch.preferredModel === null || typeof patch.preferredModel === 'string') payload.preferred_model = patch.preferredModel;

    const { data } = await this.db
      .from('conversations')
      .update(payload)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle();
    return data ? this.mapConversationRow(data) : null;
  }

  async deleteConversation(userId: string, id: string): Promise<boolean> {
    const { error, count } = await this.db
      .from('conversations')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);
    return !error && (count ?? 0) > 0;
  }

  async addMessage(userId: string, message: ChatMessage): Promise<ChatMessage> {
    const { error } = await this.db.from('messages').insert({
      id: message.id,
      conversation_id: message.conversationId,
      user_id: userId,
      role: message.role,
      content: message.content,
      provider_id: message.providerId || null,
      model_id: message.modelId || null,
      task_category: message.taskCategory || null,
      routing_reason: message.routingReason || null,
      input_tokens: message.inputTokens,
      output_tokens: message.outputTokens,
      citations: message.citations,
      created_at: message.createdAt,
    });
    if (error) throw new Error(error.message);

    await this.db
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', message.conversationId)
      .eq('user_id', userId);

    return message;
  }

  async listRoutingLogs(userId: string, limit = 50): Promise<RoutingLog[]> {
    const { data } = await this.db
      .from('routing_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).map((l) => ({
      id: String(l.id),
      userId: String(l.user_id),
      taskCategory: l.task_category as RoutingLog['taskCategory'],
      selectedProvider: l.selected_provider as RoutingLog['selectedProvider'],
      selectedModel: String(l.selected_model),
      reason: String(l.reason),
      latencyMs: Number(l.latency_ms || 0),
      fallbackUsed: Boolean(l.fallback_used),
      status: l.status as RoutingLog['status'],
      createdAt: String(l.created_at),
    }));
  }

  async addRoutingLog(log: RoutingLog): Promise<void> {
    await this.db.from('routing_logs').insert({
      id: log.id,
      user_id: log.userId,
      task_category: log.taskCategory,
      selected_provider: log.selectedProvider,
      selected_model: log.selectedModel,
      reason: log.reason,
      latency_ms: log.latencyMs,
      fallback_used: log.fallbackUsed,
      status: log.status,
      created_at: log.createdAt,
    });
  }

  async listRoutingPolicies(): Promise<RoutingPolicyRule[]> {
    const { data } = await this.db.from('routing_policies').select('*');
    if (!data || data.length === 0) return DEFAULT_ROUTING_POLICIES;
    return data.map((p) => ({
      id: String(p.id),
      name: String(p.name),
      taskCategory: p.task_category as RoutingPolicyRule['taskCategory'],
      preferredModelId: String(p.preferred_model || ''),
      fallbackModelId: String(p.fallback_model || ''),
      maxCostTier: (p.max_cost_tier as RoutingPolicyRule['maxCostTier']) || 'standard',
      active: Boolean(p.active),
    }));
  }

  async updateRoutingPolicy(
    id: string,
    patch: { active?: boolean; preferredModelId?: string; fallbackModelId?: string },
  ): Promise<RoutingPolicyRule | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof patch.active === 'boolean') payload.active = patch.active;
    if (typeof patch.preferredModelId === 'string') payload.preferred_model = patch.preferredModelId;
    if (typeof patch.fallbackModelId === 'string') payload.fallback_model = patch.fallbackModelId;
    const { data } = await this.db.from('routing_policies').update(payload).eq('id', id).select('*').maybeSingle();
    if (!data) return null;
    return {
      id: String(data.id),
      name: String(data.name),
      taskCategory: data.task_category as RoutingPolicyRule['taskCategory'],
      preferredModelId: String(data.preferred_model || ''),
      fallbackModelId: String(data.fallback_model || ''),
      maxCostTier: (data.max_cost_tier as RoutingPolicyRule['maxCostTier']) || 'standard',
      active: Boolean(data.active),
    };
  }

  async listAgents(userId: string): Promise<AgentConfig[]> {
    const { data } = await this.db.from('agents').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    return (data || []).map((a) => ({
      id: String(a.id),
      userId: String(a.user_id),
      name: String(a.name),
      category: a.category as AgentConfig['category'],
      instructions: String(a.instructions),
      allowedTools: Array.isArray(a.allowed_tools) ? a.allowed_tools : [],
      maxSteps: Number(a.max_steps || 5),
      requireApproval: Boolean(a.require_approval),
      createdAt: String(a.created_at),
    }));
  }

  async getAgent(userId: string, id: string): Promise<AgentConfig | null> {
    const { data } = await this.db.from('agents').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    if (!data) return null;
    return {
      id: String(data.id),
      userId: String(data.user_id),
      name: String(data.name),
      category: data.category as AgentConfig['category'],
      instructions: String(data.instructions),
      allowedTools: Array.isArray(data.allowed_tools) ? data.allowed_tools : [],
      maxSteps: Number(data.max_steps || 5),
      requireApproval: Boolean(data.require_approval),
      createdAt: String(data.created_at),
    };
  }

  async createAgent(agent: AgentConfig): Promise<AgentConfig> {
    const { error } = await this.db.from('agents').insert({
      id: agent.id,
      user_id: agent.userId,
      name: agent.name,
      category: agent.category,
      instructions: agent.instructions,
      allowed_tools: agent.allowedTools,
      max_steps: agent.maxSteps,
      require_approval: agent.requireApproval,
      created_at: agent.createdAt,
    });
    if (error) throw new Error(error.message);
    return agent;
  }

  async listAgentRuns(userId: string): Promise<AgentRun[]> {
    const [{ data: runs }, { data: approvals }, { data: agents }] = await Promise.all([
      this.db.from('agent_runs').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      this.db.from('agent_approvals').select('*').eq('user_id', userId).eq('decision', 'pending'),
      this.db.from('agents').select('id, name').eq('user_id', userId),
    ]);
    const agentNames = new Map((agents || []).map((a) => [String(a.id), String(a.name)]));
    const pendingByRun = new Map<string, AgentApproval>();
    for (const ap of approvals || []) {
      pendingByRun.set(String(ap.run_id), {
        id: String(ap.id),
        runId: String(ap.run_id),
        userId: String(ap.user_id),
        actionType: String(ap.action_type),
        actionSummary: String(ap.action_summary),
        decision: ap.decision as AgentApproval['decision'],
        decidedAt: ap.decided_at ? String(ap.decided_at) : null,
        createdAt: String(ap.created_at),
      });
    }
    return (runs || []).map((r) => ({
      id: String(r.id),
      agentId: String(r.agent_id),
      agentName: agentNames.get(String(r.agent_id)) || 'Agent',
      userId: String(r.user_id),
      inputTask: String(r.input_task),
      status: r.status as AgentRun['status'],
      outputSummary: r.output_summary ? String(r.output_summary) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      pendingApproval: pendingByRun.get(String(r.id)) || null,
    }));
  }

  async getAgentRun(userId: string, runId: string): Promise<AgentRun | null> {
    const { data } = await this.db.from('agent_runs').select('*').eq('id', runId).eq('user_id', userId).maybeSingle();
    if (!data) return null;
    const agent = await this.getAgent(userId, String(data.agent_id));
    return {
      id: String(data.id),
      agentId: String(data.agent_id),
      agentName: agent?.name || 'Agent',
      userId: String(data.user_id),
      inputTask: String(data.input_task),
      status: data.status as AgentRun['status'],
      outputSummary: data.output_summary ? String(data.output_summary) : null,
      errorMessage: data.error_message ? String(data.error_message) : null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    };
  }

  async createAgentRun(run: AgentRun): Promise<AgentRun> {
    const { error } = await this.db.from('agent_runs').insert({
      id: run.id,
      agent_id: run.agentId,
      user_id: run.userId,
      input_task: run.inputTask,
      status: run.status,
      output_summary: run.outputSummary,
      error_message: run.errorMessage,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
    });
    if (error) throw new Error(error.message);
    return run;
  }

  async updateAgentRun(runId: string, patch: Partial<AgentRun>): Promise<AgentRun | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.outputSummary !== undefined) payload.output_summary = patch.outputSummary;
    if (patch.errorMessage !== undefined) payload.error_message = patch.errorMessage;
    const { data } = await this.db.from('agent_runs').update(payload).eq('id', runId).select('*').maybeSingle();
    if (!data) return null;
    return {
      id: String(data.id),
      agentId: String(data.agent_id),
      agentName: 'Agent',
      userId: String(data.user_id),
      inputTask: String(data.input_task),
      status: data.status as AgentRun['status'],
      outputSummary: data.output_summary ? String(data.output_summary) : null,
      errorMessage: data.error_message ? String(data.error_message) : null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    };
  }

  async createApproval(approval: AgentApproval): Promise<AgentApproval> {
    const { error } = await this.db.from('agent_approvals').insert({
      id: approval.id,
      run_id: approval.runId,
      user_id: approval.userId,
      action_type: approval.actionType,
      action_summary: approval.actionSummary,
      decision: approval.decision,
      decided_at: approval.decidedAt,
      created_at: approval.createdAt,
    });
    if (error) throw new Error(error.message);
    return approval;
  }

  async getApproval(userId: string, approvalId: string): Promise<AgentApproval | null> {
    const { data } = await this.db
      .from('agent_approvals')
      .select('*')
      .eq('id', approvalId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) return null;
    return {
      id: String(data.id),
      runId: String(data.run_id),
      userId: String(data.user_id),
      actionType: String(data.action_type),
      actionSummary: String(data.action_summary),
      decision: data.decision as AgentApproval['decision'],
      decidedAt: data.decided_at ? String(data.decided_at) : null,
      createdAt: String(data.created_at),
    };
  }

  async resolveApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<AgentApproval | null> {
    const { data } = await this.db
      .from('agent_approvals')
      .update({ decision, decided_at: new Date().toISOString() })
      .eq('id', approvalId)
      .select('*')
      .maybeSingle();
    if (!data) return null;
    return {
      id: String(data.id),
      runId: String(data.run_id),
      userId: String(data.user_id),
      actionType: String(data.action_type),
      actionSummary: String(data.action_summary),
      decision: data.decision as AgentApproval['decision'],
      decidedAt: data.decided_at ? String(data.decided_at) : null,
      createdAt: String(data.created_at),
    };
  }

  async listResearchReports(userId: string): Promise<ResearchReport[]> {
    const { data } = await this.db
      .from('research_reports')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    return (data || []).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      query: String(r.query),
      reportMarkdown: String(r.report_markdown),
      citations: Array.isArray(r.citations) ? r.citations : [],
      providerId: r.provider_id as ResearchReport['providerId'],
      modelId: String(r.model_id),
      groundingActive: Array.isArray(r.citations) && r.citations.length > 0,
      createdAt: String(r.created_at),
    }));
  }

  async createResearchReport(report: ResearchReport): Promise<ResearchReport> {
    const { error } = await this.db.from('research_reports').insert({
      id: report.id,
      user_id: report.userId,
      query: report.query,
      report_markdown: report.reportMarkdown,
      citations: report.citations,
      provider_id: report.providerId,
      model_id: report.modelId,
      created_at: report.createdAt,
    });
    if (error) throw new Error(error.message);
    return report;
  }

  async listKnowledgeDocs(userId: string): Promise<KnowledgeDocument[]> {
    const { data } = await this.db
      .from('knowledge_documents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    return (data || []).map((d) => ({
      id: String(d.id),
      userId: String(d.user_id),
      fileName: String(d.file_name),
      mimeType: String(d.mime_type),
      byteSize: Number(d.byte_size || 0),
      chunkCount: Number(d.chunk_count || 0),
      storagePath: d.storage_path ? String(d.storage_path) : null,
      retrievalMode: (d.retrieval_mode as KnowledgeDocument['retrievalMode']) || 'keyword_rank',
      createdAt: String(d.created_at),
    }));
  }

  async uploadKnowledgeDoc(params: {
    userId: string;
    fileName: string;
    mimeType: string;
    content: string;
  }): Promise<KnowledgeDocument> {
    const docId = crypto.randomUUID();
    const safeName = params.fileName.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${params.userId}/${docId}/${safeName}`;
    const bytes = new TextEncoder().encode(params.content);

    // Upload raw document to private Supabase Storage bucket
    const { error: uploadErr } = await this.db.storage
      .from(KNOWLEDGE_BUCKET)
      .upload(storagePath, bytes, { contentType: params.mimeType, upsert: false });

    const effectiveStoragePath = uploadErr ? null : storagePath;
    const chunks = chunkTextDocument(params.content);
    const now = new Date().toISOString();

    const { error: docErr } = await this.db.from('knowledge_documents').insert({
      id: docId,
      user_id: params.userId,
      file_name: params.fileName.trim(),
      mime_type: params.mimeType,
      byte_size: bytes.length,
      chunk_count: chunks.length,
      storage_path: effectiveStoragePath,
      retrieval_mode: 'keyword_rank',
      created_at: now,
    });
    if (docErr) throw new Error(docErr.message);

    if (chunks.length > 0) {
      await this.db.from('knowledge_chunks').insert(
        chunks.map((content, idx) => ({
          id: crypto.randomUUID(),
          document_id: docId,
          user_id: params.userId,
          chunk_index: idx,
          content,
        })),
      );
    }

    return {
      id: docId,
      userId: params.userId,
      fileName: params.fileName.trim(),
      mimeType: params.mimeType,
      byteSize: bytes.length,
      chunkCount: chunks.length,
      storagePath: effectiveStoragePath,
      retrievalMode: 'keyword_rank',
      createdAt: now,
    };
  }

  async deleteKnowledgeDoc(userId: string, id: string): Promise<boolean> {
    const { data: doc } = await this.db
      .from('knowledge_documents')
      .select('id, storage_path')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!doc) return false;

    if (doc.storage_path) {
      await this.db.storage.from(KNOWLEDGE_BUCKET).remove([String(doc.storage_path)]);
    }
    const { error } = await this.db.from('knowledge_documents').delete().eq('id', id).eq('user_id', userId);
    return !error;
  }

  async searchKnowledgeChunks(userId: string, query: string, limit = 5): Promise<KnowledgeChunkMatch[]> {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u0980-\u09ff]+/)
      .filter((t) => t.length >= 2);
    if (terms.length === 0) return [];

    const [{ data: chunks }, { data: docs }] = await Promise.all([
      this.db.from('knowledge_chunks').select('document_id, chunk_index, content').eq('user_id', userId).limit(300),
      this.db.from('knowledge_documents').select('id, file_name').eq('user_id', userId),
    ]);
    const docNames = new Map((docs || []).map((d) => [String(d.id), String(d.file_name)]));

    const scored: KnowledgeChunkMatch[] = [];
    for (const chunk of chunks || []) {
      const content = String(chunk.content || '');
      const lower = content.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (lower.includes(term)) hits += 1;
      }
      if (hits > 0) {
        const docId = String(chunk.document_id);
        scored.push({
          documentId: docId,
          fileName: docNames.get(docId) || 'Document',
          chunkIndex: Number(chunk.chunk_index || 0),
          content,
          score: Number((hits / terms.length).toFixed(3)),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async listMemories(userId: string): Promise<UserMemory[]> {
    const { data } = await this.db
      .from('user_memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    return (data || []).map((m) => ({
      id: String(m.id),
      userId: String(m.user_id),
      fact: String(m.fact),
      source: (m.source as UserMemory['source']) || 'user',
      createdAt: String(m.created_at),
    }));
  }

  async addMemory(userId: string, fact: string): Promise<UserMemory> {
    const mem: UserMemory = {
      id: crypto.randomUUID(),
      userId,
      fact,
      source: 'user',
      createdAt: new Date().toISOString(),
    };
    const { error } = await this.db.from('user_memories').insert({
      id: mem.id,
      user_id: mem.userId,
      fact: mem.fact,
      source: mem.source,
      created_at: mem.createdAt,
    });
    if (error) throw new Error(error.message);
    return mem;
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    const { error, count } = await this.db
      .from('user_memories')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);
    return !error && (count ?? 0) > 0;
  }

  async getAdminOverview() {
    const [u, c, p, a, r, us] = await Promise.all([
      this.db.from('profiles').select('id', { count: 'exact', head: true }),
      this.db.from('conversations').select('id', { count: 'exact', head: true }),
      this.db.from('projects').select('id', { count: 'exact', head: true }),
      this.db.from('agents').select('id', { count: 'exact', head: true }),
      this.db.from('routing_logs').select('id', { count: 'exact', head: true }),
      this.db.from('usage_records').select('id', { count: 'exact', head: true }),
    ]);
    return {
      totalUsers: u.count ?? 0,
      totalConversations: c.count ?? 0,
      totalProjects: p.count ?? 0,
      totalAgents: a.count ?? 0,
      totalRoutingLogs: r.count ?? 0,
      totalUsageRecords: us.count ?? 0,
    };
  }

  async listAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    const { data } = await this.db
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).map((row) => ({
      id: String(row.id),
      actorId: String(row.actor_id || 'system'),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id ? String(row.resource_id) : null,
      detail: String((row.metadata as { detail?: string } | null)?.detail || ''),
      createdAt: String(row.created_at),
    }));
  }

  async appendAuditLog(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    await this.db.from('audit_logs').insert({
      actor_id: entry.actorId === 'system' ? null : entry.actorId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      metadata: { detail: entry.detail },
    });
  }

  async listFeatureFlags(): Promise<FeatureFlag[]> {
    const { data } = await this.db.from('feature_flags').select('*').order('key', { ascending: true });
    return (data || []).map((f) => ({
      key: String(f.key),
      enabled: Boolean(f.enabled),
      description: String(f.description || ''),
    }));
  }

  async toggleFeatureFlag(key: string, enabled: boolean): Promise<FeatureFlag | null> {
    const { data } = await this.db
      .from('feature_flags')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('key', key)
      .select('*')
      .maybeSingle();
    if (!data) return null;
    return {
      key: String(data.key),
      enabled: Boolean(data.enabled),
      description: String(data.description || ''),
    };
  }
}
