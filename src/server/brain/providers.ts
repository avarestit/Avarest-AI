import { GoogleGenAI } from '@google/genai';
import type { CitationItem, ProviderId } from '../../shared/types.ts';
import type { ResolvedServerConfig } from '../env.ts';

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ProviderCompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  citations: CitationItem[];
  groundingActive: boolean;
}

export class ProviderExecutionError extends Error {
  statusCode: number;
  providerId: ProviderId;

  constructor(providerId: ProviderId, message: string, statusCode = 502) {
    super(message);
    this.providerId = providerId;
    this.statusCode = statusCode;
  }
}

export async function executeProviderCompletion(params: {
  providerId: ProviderId;
  modelId: string;
  messages: ProviderMessage[];
  systemInstruction?: string;
  enableWebSearch?: boolean;
  config: ResolvedServerConfig;
  signal?: AbortSignal;
}): Promise<ProviderCompletionResult> {
  const { providerId, modelId, messages, systemInstruction, enableWebSearch, config } = params;

  if (providerId === 'gemini') {
    const apiKey = config.providers.gemini;
    if (!apiKey) {
      throw new ProviderExecutionError('gemini', 'GEMINI_API_KEY is not configured on the server.', 503);
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    try {
      const response = await ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(enableWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
        },
      });

      const citations: CitationItem[] = [];
      const groundingChunks =
        (response as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }> })
          .candidates?.[0]?.groundingMetadata?.groundingChunks || [];

      for (const chunk of groundingChunks) {
        if (chunk.web?.uri) {
          citations.push({
            title: chunk.web.title || chunk.web.uri,
            url: chunk.web.uri,
          });
        }
      }

      const usage = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;

      return {
        text: response.text || '',
        inputTokens: usage?.promptTokenCount || estimateTokens(messages.map((m) => m.content).join(' ')),
        outputTokens: usage?.candidatesTokenCount || estimateTokens(response.text || ''),
        citations,
        groundingActive: Boolean(enableWebSearch && citations.length > 0),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini upstream request failed';
      const status = msg.includes('403') || msg.includes('PERMISSION_DENIED') ? 403 : msg.includes('429') ? 429 : 502;
      throw new ProviderExecutionError('gemini', `Gemini API error: ${msg}`, status);
    }
  }

  if (providerId === 'anthropic') {
    const apiKey = config.providers.anthropic;
    if (!apiKey) {
      throw new ProviderExecutionError('anthropic', 'ANTHROPIC_API_KEY is not configured on the server.', 503);
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: params.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 2048,
        ...(systemInstruction ? { system: systemInstruction } : {}),
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new ProviderExecutionError('anthropic', `Anthropic API error (${res.status}): ${errText}`, res.status);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');

    return {
      text,
      inputTokens: data.usage?.input_tokens || estimateTokens(messages.map((m) => m.content).join(' ')),
      outputTokens: data.usage?.output_tokens || estimateTokens(text),
      citations: [],
      groundingActive: false,
    };
  }

  // OpenAI-compatible adapters (OpenAI, DeepSeek, xAI Grok, Meta Llama)
  let endpoint = '';
  let apiKey: string | undefined;

  if (providerId === 'openai') {
    endpoint = 'https://api.openai.com/v1/chat/completions';
    apiKey = config.providers.openai;
  } else if (providerId === 'deepseek') {
    endpoint = 'https://api.deepseek.com/chat/completions';
    apiKey = config.providers.deepseek;
  } else if (providerId === 'xai') {
    endpoint = 'https://api.x.ai/v1/chat/completions';
    apiKey = config.providers.xai;
  } else if (providerId === 'llama') {
    endpoint = `${config.providers.llamaBaseUrl.replace(/\/$/, '')}/chat/completions`;
    apiKey = config.providers.llama;
  }

  if (!apiKey) {
    throw new ProviderExecutionError(providerId, `${providerId.toUpperCase()} API key is not configured on the server.`, 503);
  }

  const chatMessages: ProviderMessage[] = [];
  if (systemInstruction) {
    chatMessages.push({ role: 'system', content: systemInstruction });
  }
  for (const m of messages) {
    if (m.role !== 'system') chatMessages.push(m);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    signal: params.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: chatMessages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ProviderExecutionError(providerId, `${providerId} API error (${res.status}): ${errText}`, res.status);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content || '';

  return {
    text,
    inputTokens: data.usage?.prompt_tokens || estimateTokens(messages.map((m) => m.content).join(' ')),
    outputTokens: data.usage?.completion_tokens || estimateTokens(text),
    citations: [],
    groundingActive: false,
  };
}

export async function* streamProviderCompletion(params: {
  providerId: ProviderId;
  modelId: string;
  messages: ProviderMessage[];
  systemInstruction?: string;
  config: ResolvedServerConfig;
  signal?: AbortSignal;
}): AsyncGenerator<{ delta: string; done?: boolean; result?: ProviderCompletionResult }> {
  if (params.providerId === 'gemini') {
    const apiKey = params.config.providers.gemini;
    if (!apiKey) {
      throw new ProviderExecutionError('gemini', 'GEMINI_API_KEY is not configured on the server.', 503);
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const contents = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    try {
      const stream = await ai.models.generateContentStream({
        model: params.modelId,
        contents,
        config: {
          ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
        },
      });

      let fullText = '';
      for await (const chunk of stream) {
        if (params.signal?.aborted) break;
        const delta = chunk.text || '';
        if (delta) {
          fullText += delta;
          yield { delta };
        }
      }

      yield {
        delta: '',
        done: true,
        result: {
          text: fullText,
          inputTokens: estimateTokens(params.messages.map((m) => m.content).join(' ')),
          outputTokens: estimateTokens(fullText),
          citations: [],
          groundingActive: false,
        },
      };
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini streaming failed';
      throw new ProviderExecutionError('gemini', `Gemini streaming error: ${msg}`, 502);
    }
  }

  // Fallback to non-stream execution for providers where SSE adapter is unified
  const full = await executeProviderCompletion(params);
  yield { delta: full.text };
  yield { delta: '', done: true, result: full };
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
