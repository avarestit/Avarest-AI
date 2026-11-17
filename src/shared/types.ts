export type UserRole = 'user' | 'admin' | 'super_admin';
export type LanguageCode = 'en' | 'bn';
export type ExperienceMode = 'beginner' | 'advanced';
export type PlanTier = 'free' | 'starter' | 'pro' | 'ultra' | 'team' | 'business' | 'enterprise';

export type TaskCategory =
  | 'general_chat'
  | 'coding'
  | 'research'
  | 'reasoning'
  | 'creative_writing'
  | 'image_generation'
  | 'document_analysis';

export type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'deepseek' | 'xai' | 'llama';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  language: LanguageCode;
  experienceMode: ExperienceMode;
  memoryConsent: boolean;
  activePlan: PlanTier;
  createdAt: string;
}

export interface ModelCapabilitySpec {
  id: string;
  providerId: ProviderId;
  providerName: string;
  displayName: string;
  capabilities: Array<'chat' | 'streaming' | 'coding' | 'research' | 'reasoning' | 'image' | 'audio' | 'video'>;
  contextWindow: number;
  costTier: 'economy' | 'standard' | 'premium';
  latencyTier: 'ultra_fast' | 'fast' | 'reasoning';
  configured: boolean;
  unavailableReason?: string;
}

export interface CitationItem {
  title: string;
  url: string;
  snippet?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  providerId?: ProviderId | null;
  modelId?: string | null;
  taskCategory?: TaskCategory | null;
  routingReason?: string | null;
  inputTokens: number;
  outputTokens: number;
  usageIsEstimated?: boolean;
  citations: CitationItem[];
  createdAt: string;
}

export interface Conversation {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  routingMode: 'auto' | 'manual';
  preferredModel: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingDecision {
  taskCategory: TaskCategory;
  selectedProvider: ProviderId;
  selectedModel: string;
  reason: string;
  fallbackUsed: boolean;
}

export interface RoutingLog {
  id: string;
  userId: string;
  taskCategory: TaskCategory;
  selectedProvider: ProviderId;
  selectedModel: string;
  reason: string;
  latencyMs: number;
  fallbackUsed: boolean;
  status: 'success' | 'error' | 'fallback';
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  userId: string;
  name: string;
  category: 'research' | 'coding' | 'browser' | 'marketing' | 'business' | 'document' | 'automation';
  instructions: string;
  allowedTools: string[];
  maxSteps: number;
  requireApproval: boolean;
  createdAt: string;
}

export interface AgentApproval {
  id: string;
  runId: string;
  userId: string;
  actionType: string;
  actionSummary: string;
  decision: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  userId: string;
  inputTask: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'canceled';
  outputSummary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  pendingApproval?: AgentApproval | null;
}

export interface ResearchReport {
  id: string;
  userId: string;
  query: string;
  reportMarkdown: string;
  citations: CitationItem[];
  providerId: ProviderId;
  modelId: string;
  groundingActive: boolean;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  userId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  chunkCount: number;
  storagePath?: string | null;
  retrievalMode?: 'keyword_rank' | 'pgvector_hybrid';
  createdAt: string;
}

export interface KnowledgeChunkMatch {
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface UserMemory {
  id: string;
  userId: string;
  fact: string;
  source: 'user' | 'assistant';
  createdAt: string;
}

export interface ConnectedAccount {
  id: string;
  provider: 'github' | 'google_drive' | 'gmail' | 'google_calendar' | 'mcp';
  displayName: string;
  status: 'not_configured' | 'disconnected' | 'connected' | 'revoked';
  oauthConfigured: boolean;
  scopes: string[];
  detail: string;
}

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  referenceId: string | null;
  createdAt: string;
}

export interface UsageSummary {
  balance: number;
  monthlyAllowance: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  ledger: CreditLedgerEntry[];
}

export interface SystemHealthStatus {
  status: 'ok' | 'degraded';
  environment: 'staging' | 'production';
  storageMode: 'supabase_postgres' | 'local_memory_sandbox' | 'unconfigured_blocked';
  rateLimitMode: 'distributed_kv' | 'single_instance_memory';
  supabase: {
    expectedUrl: string;
    configured: boolean;
    dbReachable: boolean;
    dbLatencyMs?: number;
    dbError?: string;
    isolated: boolean;
    authMode: 'supabase' | 'local_sandbox' | 'unconfigured_blocked';
    errors: string[];
  };
  providers: Array<{
    id: ProviderId;
    displayName: string;
    configured: boolean;
  }>;
  configValidation?: {
    missingRequired: string[];
    missingOptional: string[];
    warnings: string[];
    authSessionSecretStrong: boolean;
    adminBootstrapSecretStrong: boolean;
  };
  timestamp: string;
}
