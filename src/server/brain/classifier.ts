import type { TaskCategory } from '../../shared/types.ts';

export interface ClassificationResult {
  category: TaskCategory;
  confidenceLabel: string;
  requiredCapabilities: Array<'chat' | 'coding' | 'research' | 'reasoning' | 'image'>;
  estimatedContextNeed: 'low' | 'medium' | 'high';
}

const CODING_PATTERNS = /\b(code|bug|debug|refactor|typescript|javascript|python|rust|sql|react|api|function|class|error|stacktrace|regex|test|dockerfile|html|css)\b/i;
const RESEARCH_PATTERNS = /\b(research|sources|citations|latest|news|market|compare|benchmark|report|evidence|study|paper)\b/i;
const REASONING_PATTERNS = /\b(architect|architecture|prove|proof|math|equation|security audit|analyze|tradeoff|strategy|root cause|system design)\b/i;
const DOC_PATTERNS = /\b(summarize|document|pdf|extract|outline|transcript|notes|contract|clause)\b/i;
const CREATIVE_PATTERNS = /\b(story|poem|copywriting|blog|script|email draft|slogan|headline|marketing)\b/i;

export function classifyPromptTask(prompt: string, explicitHint?: TaskCategory): ClassificationResult {
  if (explicitHint) {
    return {
      category: explicitHint,
      confidenceLabel: 'explicit_workflow',
      requiredCapabilities:
        explicitHint === 'coding'
          ? ['chat', 'coding']
          : explicitHint === 'research'
            ? ['chat', 'research']
            : explicitHint === 'reasoning'
              ? ['chat', 'reasoning']
              : ['chat'],
      estimatedContextNeed: prompt.length > 4000 ? 'high' : prompt.length > 800 ? 'medium' : 'low',
    };
  }

  const trimmed = prompt.trim();
  const contextNeed = trimmed.length > 4000 ? 'high' : trimmed.length > 800 ? 'medium' : 'low';

  if (CODING_PATTERNS.test(trimmed)) {
    return {
      category: 'coding',
      confidenceLabel: 'pattern_match',
      requiredCapabilities: ['chat', 'coding'],
      estimatedContextNeed: contextNeed,
    };
  }

  if (RESEARCH_PATTERNS.test(trimmed)) {
    return {
      category: 'research',
      confidenceLabel: 'pattern_match',
      requiredCapabilities: ['chat', 'research'],
      estimatedContextNeed: contextNeed,
    };
  }

  if (REASONING_PATTERNS.test(trimmed)) {
    return {
      category: 'reasoning',
      confidenceLabel: 'pattern_match',
      requiredCapabilities: ['chat', 'reasoning'],
      estimatedContextNeed: contextNeed,
    };
  }

  if (DOC_PATTERNS.test(trimmed)) {
    return {
      category: 'document_analysis',
      confidenceLabel: 'pattern_match',
      requiredCapabilities: ['chat'],
      estimatedContextNeed: contextNeed === 'low' ? 'medium' : contextNeed,
    };
  }

  if (CREATIVE_PATTERNS.test(trimmed)) {
    return {
      category: 'creative_writing',
      confidenceLabel: 'pattern_match',
      requiredCapabilities: ['chat'],
      estimatedContextNeed: contextNeed,
    };
  }

  return {
    category: 'general_chat',
    confidenceLabel: 'default_classification',
    requiredCapabilities: ['chat'],
    estimatedContextNeed: contextNeed,
  };
}
