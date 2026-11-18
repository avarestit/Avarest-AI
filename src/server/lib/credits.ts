import type { CreditExecutionFeature, ModelCapabilitySpec } from '../../shared/types.ts';

export const DEFAULT_RESERVATION_TTL_SECONDS = 300;

export function getFeatureMinimumCredits(feature: CreditExecutionFeature): number {
  switch (feature) {
    case 'research':
      return 0.25;
    case 'coder':
    case 'agent_immediate':
    case 'agent_approval':
      return 0.2;
    case 'chat':
    case 'chat_stream':
    default:
      return 0.1;
  }
}

export function calculateActualCreditCost(params: {
  feature: CreditExecutionFeature;
  inputTokens: number;
  outputTokens: number;
}): number {
  const minCost = getFeatureMinimumCredits(params.feature);
  const input = Math.max(0, Number.isFinite(params.inputTokens) ? params.inputTokens : 0);
  const output = Math.max(0, Number.isFinite(params.outputTokens) ? params.outputTokens : 0);
  return Number(Math.max(minCost, (input + output) / 1000).toFixed(4));
}

export function estimateReservationCredits(params: {
  feature: CreditExecutionFeature;
  promptText: string;
  expectedOutputTokens?: number;
  costTier?: ModelCapabilitySpec['costTier'];
}): number {
  const minCost = getFeatureMinimumCredits(params.feature);
  const estInputTokens = Math.max(1, Math.ceil((params.promptText || '').length / 4));
  const defaultOutputTokens =
    params.feature === 'research'
      ? 1200
      : params.feature === 'coder' || params.feature === 'agent_immediate' || params.feature === 'agent_approval'
        ? 900
        : 500;
  const outputTokens = params.expectedOutputTokens ?? defaultOutputTokens;
  const tierFactor = params.costTier === 'premium' ? 1.5 : params.costTier === 'standard' ? 1.2 : 1.0;
  const raw = ((estInputTokens + outputTokens) / 1000) * tierFactor;
  return Number(Math.max(minCost, raw).toFixed(4));
}

export function normalizeIdempotencyKey(rawHeader: string | undefined): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}
