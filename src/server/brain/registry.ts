import type { ModelCapabilitySpec, ProviderId } from '../../shared/types.ts';
import type { ResolvedServerConfig } from '../env.ts';

interface StaticModelDef {
  id: string;
  providerId: ProviderId;
  providerName: string;
  displayName: string;
  capabilities: ModelCapabilitySpec['capabilities'];
  contextWindow: number;
  costTier: ModelCapabilitySpec['costTier'];
  latencyTier: ModelCapabilitySpec['latencyTier'];
}

const MODEL_CATALOG: StaticModelDef[] = [
  {
    id: 'gemini-4-hydrogen',
    providerId: 'gemini',
    providerName: 'Google Gemini',
    displayName: 'Gemini 4 Hydrogen',
    capabilities: ['chat', 'streaming', 'coding', 'research', 'reasoning'],
    contextWindow: 1000000,
    costTier: 'standard',
    latencyTier: 'fast',
  },
  {
    id: 'gemini-3.1-flash-lite',
    providerId: 'gemini',
    providerName: 'Google Gemini',
    displayName: 'Gemini 3.1 Flash Lite',
    capabilities: ['chat', 'streaming', 'research'],
    contextWindow: 1000000,
    costTier: 'economy',
    latencyTier: 'ultra_fast',
  },
  {
    id: 'gpt-4o-mini',
    providerId: 'openai',
    providerName: 'OpenAI',
    displayName: 'GPT-4o Mini',
    capabilities: ['chat', 'streaming', 'coding'],
    contextWindow: 128000,
    costTier: 'economy',
    latencyTier: 'ultra_fast',
  },
  {
    id: 'gpt-4o',
    providerId: 'openai',
    providerName: 'OpenAI',
    displayName: 'GPT-4o',
    capabilities: ['chat', 'streaming', 'coding', 'reasoning'],
    contextWindow: 128000,
    costTier: 'premium',
    latencyTier: 'fast',
  },
  {
    id: 'claude-3-5-sonnet-latest',
    providerId: 'anthropic',
    providerName: 'Anthropic Claude',
    displayName: 'Claude 3.5 Sonnet',
    capabilities: ['chat', 'streaming', 'coding', 'reasoning'],
    contextWindow: 200000,
    costTier: 'premium',
    latencyTier: 'fast',
  },
  {
    id: 'deepseek-chat',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    displayName: 'DeepSeek V3',
    capabilities: ['chat', 'streaming', 'coding', 'reasoning'],
    contextWindow: 64000,
    costTier: 'economy',
    latencyTier: 'fast',
  },
  {
    id: 'grok-2-latest',
    providerId: 'xai',
    providerName: 'xAI Grok',
    displayName: 'Grok 2',
    capabilities: ['chat', 'streaming', 'research'],
    contextWindow: 131072,
    costTier: 'standard',
    latencyTier: 'fast',
  },
  {
    id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    providerId: 'llama',
    providerName: 'Meta Llama',
    displayName: 'Llama 3.3 70B Instruct',
    capabilities: ['chat', 'streaming', 'coding'],
    contextWindow: 128000,
    costTier: 'economy',
    latencyTier: 'fast',
  },
];

export function isProviderConfigured(providerId: ProviderId, config: ResolvedServerConfig): boolean {
  switch (providerId) {
    case 'gemini':
      return Boolean(config.providers.gemini);
    case 'openai':
      return Boolean(config.providers.openai);
    case 'anthropic':
      return Boolean(config.providers.anthropic);
    case 'deepseek':
      return Boolean(config.providers.deepseek);
    case 'xai':
      return Boolean(config.providers.xai);
    case 'llama':
      return Boolean(config.providers.llama);
  }
}

export function getModelRegistry(config: ResolvedServerConfig): ModelCapabilitySpec[] {
  return MODEL_CATALOG.map((model) => {
    const configured = isProviderConfigured(model.providerId, config);
    return {
      ...model,
      configured,
      unavailableReason: configured
        ? undefined
        : `Server credential for ${model.providerName} is not configured in this environment.`,
    };
  });
}

export function getProviderSummary(config: ResolvedServerConfig): Array<{
  id: ProviderId;
  displayName: string;
  configured: boolean;
}> {
  const entries: Array<{ id: ProviderId; displayName: string }> = [
    { id: 'gemini', displayName: 'Google Gemini' },
    { id: 'openai', displayName: 'OpenAI' },
    { id: 'anthropic', displayName: 'Anthropic Claude' },
    { id: 'deepseek', displayName: 'DeepSeek' },
    { id: 'xai', displayName: 'xAI Grok' },
    { id: 'llama', displayName: 'Meta Llama' },
  ];
  return entries.map((entry) => ({
    ...entry,
    configured: isProviderConfigured(entry.id, config),
  }));
}
