import type {
  ModelCapabilitySpec,
  PlanTier,
  RoutingDecision,
  TaskCategory,
} from '../../shared/types.ts';
import type { ResolvedServerConfig } from '../env.ts';
import { classifyPromptTask } from './classifier.ts';
import { getModelRegistry, isProviderEnabledForRelease } from './registry.ts';

export interface RoutingPolicyRule {
  id: string;
  name: string;
  taskCategory: TaskCategory;
  preferredModelId: string;
  fallbackModelId: string;
  maxCostTier: 'economy' | 'standard' | 'premium';
  active: boolean;
}

export const DEFAULT_ROUTING_POLICIES: RoutingPolicyRule[] = [
  {
    id: 'pol-general',
    name: 'General Conversation',
    taskCategory: 'general_chat',
    preferredModelId: 'gemini-4-hydrogen',
    fallbackModelId: 'gpt-4o-mini',
    maxCostTier: 'standard',
    active: true,
  },
  {
    id: 'pol-coding',
    name: 'Software Engineering & Code',
    taskCategory: 'coding',
    preferredModelId: 'claude-3-5-sonnet-latest',
    fallbackModelId: 'deepseek-chat',
    maxCostTier: 'premium',
    active: true,
  },
  {
    id: 'pol-research',
    name: 'Deep Research & Grounding',
    taskCategory: 'research',
    preferredModelId: 'gemini-4-hydrogen',
    fallbackModelId: 'gemini-3.1-flash-lite',
    maxCostTier: 'standard',
    active: true,
  },
  {
    id: 'pol-reasoning',
    name: 'Architecture & Deep Reasoning',
    taskCategory: 'reasoning',
    preferredModelId: 'gpt-4o',
    fallbackModelId: 'deepseek-reasoner',
    maxCostTier: 'premium',
    active: true,
  },
  {
    id: 'pol-docs',
    name: 'Long-Context Document Analysis',
    taskCategory: 'document_analysis',
    preferredModelId: 'gemini-4-hydrogen',
    fallbackModelId: 'claude-3-5-haiku-latest',
    maxCostTier: 'standard',
    active: true,
  },
  {
    id: 'pol-creative',
    name: 'Creative & Editorial Writing',
    taskCategory: 'creative_writing',
    preferredModelId: 'gemini-4-hydrogen',
    fallbackModelId: 'gpt-4o-mini',
    maxCostTier: 'standard',
    active: true,
  },
];

export class BrainRoutingError extends Error {
  code: 'NO_CONFIGURED_PROVIDERS' | 'MODEL_UNAVAILABLE' | 'MODEL_NOT_FOUND';
  statusCode: number;

  constructor(
    code: 'NO_CONFIGURED_PROVIDERS' | 'MODEL_UNAVAILABLE' | 'MODEL_NOT_FOUND',
    message: string,
    statusCode = 503,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function routeWithAvarestBrain(params: {
  prompt: string;
  config: ResolvedServerConfig;
  mode: 'auto' | 'manual';
  requestedModelId?: string | null;
  explicitTask?: TaskCategory;
  userPlan?: PlanTier;
  policies?: RoutingPolicyRule[];
}): RoutingDecision {
  const registry = getModelRegistry(params.config).filter((m) => isProviderEnabledForRelease(m.providerId));
  const configuredModels = registry.filter((m) => m.configured);

  if (configuredModels.length === 0) {
    throw new BrainRoutingError(
      'NO_CONFIGURED_PROVIDERS',
      'No active AI provider API keys are configured on the server. Configure OpenAI, Google Gemini, Anthropic Claude, or DeepSeek in server Secrets.',
      503,
    );
  }

  const classification = classifyPromptTask(params.prompt, params.explicitTask);

  // Manual selection mode: enforce existence & configured provider check
  if (params.mode === 'manual' && params.requestedModelId) {
    const requested = registry.find((m) => m.id === params.requestedModelId);
    if (!requested) {
      throw new BrainRoutingError(
        'MODEL_NOT_FOUND',
        `Requested model "${params.requestedModelId}" is not available in the active Avarest Brain registry.`,
        400,
      );
    }
    if (!requested.configured) {
      throw new BrainRoutingError(
        'MODEL_UNAVAILABLE',
        `Requested model "${requested.displayName}" requires server-side credentials for ${requested.providerName}, which are not configured.`,
        503,
      );
    }

    return {
      taskCategory: classification.category,
      selectedProvider: requested.providerId,
      selectedModel: requested.id,
      reason: `Manual user selection (${requested.displayName}) verified against active server registry.`,
      fallbackUsed: false,
    };
  }

  // Automatic Avarest Brain capability-aware routing
  const activePolicies = params.policies || DEFAULT_ROUTING_POLICIES;
  const matchingPolicy = activePolicies.find(
    (p) => p.active && p.taskCategory === classification.category,
  );

  const isFreeTier = !params.userPlan || params.userPlan === 'free';
  const maxAllowedRank = isFreeTier ? 1 : 3;
  const costRank: Record<ModelCapabilitySpec['costTier'], number> = {
    economy: 1,
    standard: 2,
    premium: 3,
  };

  if (matchingPolicy) {
    const preferred = configuredModels.find((m) => m.id === matchingPolicy.preferredModelId);
    if (preferred && (costRank[preferred.costTier] <= maxAllowedRank || configuredModels.length === 1)) {
      return {
        taskCategory: classification.category,
        selectedProvider: preferred.providerId,
        selectedModel: preferred.id,
        reason: `Policy "${matchingPolicy.name}" matched task "${classification.category}" to ${preferred.displayName}.`,
        fallbackUsed: false,
      };
    }

    const fallback = configuredModels.find((m) => m.id === matchingPolicy.fallbackModelId);
    if (fallback) {
      return {
        taskCategory: classification.category,
        selectedProvider: fallback.providerId,
        selectedModel: fallback.id,
        reason: `Policy "${matchingPolicy.name}" routed via configured fallback to ${fallback.displayName}.`,
        fallbackUsed: true,
      };
    }
  }

  // General capability scoring over configured models
  const scored = [...configuredModels].sort((a, b) => {
    const aCapHits = classification.requiredCapabilities.filter((c) => a.capabilities.includes(c)).length;
    const bCapHits = classification.requiredCapabilities.filter((c) => b.capabilities.includes(c)).length;
    if (bCapHits !== aCapHits) return bCapHits - aCapHits;
    return costRank[a.costTier] - costRank[b.costTier];
  });

  const best = scored[0];
  return {
    taskCategory: classification.category,
    selectedProvider: best.providerId,
    selectedModel: best.id,
    reason: `Capability-based routing selected ${best.displayName} for "${classification.category}".`,
    fallbackUsed: Boolean(matchingPolicy),
  };
}
