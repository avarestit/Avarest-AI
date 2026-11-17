import { GoogleGenAI } from '@google/genai';
import type { CitationItem, ProviderId } from '../../shared/types.ts';
import type { ResolvedServerConfig } from '../env.ts';
import { isProviderEnabledForRelease } from './registry.ts';

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ProviderCompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usageIsEstimated: boolean;
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

const DEFAULT_TIMEOUT_MS = 45_000;

function withTimeoutSignal(callerSignal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('UPSTREAM_TIMEOUT')), timeoutMs);
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
}

export function sanitizeProviderErrorMessage(providerId: ProviderId, status: number, rawMessage?: string): string {
  const label =
    providerId === 'gemini'
      ? 'Google Gemini'
      : providerId === 'openai'
        ? 'OpenAI'
        : providerId === 'anthropic'
          ? 'Anthropic Claude'
          : 'DeepSeek';

  const lowered = (rawMessage || '').toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('abort')) {
    return `${label} request timed out. Please retry.`;
  }
  if (status === 401 || status === 403 || lowered.includes('permission_denied') || lowered.includes('invalid_api_key')) {
    return `${label} authentication failed. Verify server credentials.`;
  }
  if (status === 429 || lowered.includes('rate_limit') || lowered.includes('quota')) {
    return `${label} rate limit or quota reached. Please wait briefly and retry.`;
  }
  if (status === 400 || status === 404) {
    return `${label} rejected the request parameters or model identifier.`;
  }
  return `${label} upstream service is temporarily unavailable.`;
}

function getOpenAICompatibleEndpoint(providerId: ProviderId): { endpoint: string; label: string } {
  if (providerId === 'openai') {
    return { endpoint: 'https://api.openai.com/v1/chat/completions', label: 'OpenAI' };
  }
  if (providerId === 'deepseek') {
    return { endpoint: 'https://api.deepseek.com/chat/completions', label: 'DeepSeek' };
  }
  throw new ProviderExecutionError(providerId, `Provider "${providerId}" is not active in this release.`, 503);
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
  const maxAttempts = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (params.signal?.aborted) {
      throw new ProviderExecutionError(params.providerId, sanitizeProviderErrorMessage(params.providerId, 499, 'abort'), 499);
    }
    try {
      return await executeProviderCompletionOnce(params);
    } catch (err) {
      lastErr = err;
      const isRetryable =
        err instanceof ProviderExecutionError &&
        (err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504) &&
        !err.message.toLowerCase().includes('not configured') &&
        !err.message.toLowerCase().includes('disabled');
      if (!isRetryable || attempt === maxAttempts || params.signal?.aborted) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastErr;
}

async function executeProviderCompletionOnce(params: {
  providerId: ProviderId;
  modelId: string;
  messages: ProviderMessage[];
  systemInstruction?: string;
  enableWebSearch?: boolean;
  config: ResolvedServerConfig;
  signal?: AbortSignal;
}): Promise<ProviderCompletionResult> {
  const { providerId, modelId, messages, systemInstruction, enableWebSearch, config } = params;

  if (!isProviderEnabledForRelease(providerId)) {
    throw new ProviderExecutionError(providerId, `Provider "${providerId}" is disabled for the initial release.`, 503);
  }

  const promptCharText = messages.map((m) => m.content).join(' ');
  const { signal, cleanup } = withTimeoutSignal(params.signal);

  try {
    if (providerId === 'gemini') {
      const apiKey = config.providers.gemini;
      if (!apiKey) {
        throw new ProviderExecutionError('gemini', 'Google Gemini server credential is not configured.', 503);
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
        const hasRealUsage = typeof usage?.promptTokenCount === 'number' && typeof usage?.candidatesTokenCount === 'number';
        const text = response.text || '';

        return {
          text,
          inputTokens: usage?.promptTokenCount ?? estimateTokens(promptCharText),
          outputTokens: usage?.candidatesTokenCount ?? estimateTokens(text),
          usageIsEstimated: !hasRealUsage,
          citations,
          groundingActive: Boolean(enableWebSearch && citations.length > 0),
        };
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : '';
        const status = rawMsg.includes('403') || rawMsg.includes('PERMISSION_DENIED') ? 403 : rawMsg.includes('429') ? 429 : 502;
        throw new ProviderExecutionError('gemini', sanitizeProviderErrorMessage('gemini', status, rawMsg), status);
      }
    }

    if (providerId === 'anthropic') {
      const apiKey = config.providers.anthropic;
      if (!apiKey) {
        throw new ProviderExecutionError('anthropic', 'Anthropic Claude server credential is not configured.', 503);
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 4096,
          ...(systemInstruction ? { system: systemInstruction } : {}),
          messages: messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new ProviderExecutionError('anthropic', sanitizeProviderErrorMessage('anthropic', res.status, errText), res.status);
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content || [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n');

      const hasRealUsage = typeof data.usage?.input_tokens === 'number' && typeof data.usage?.output_tokens === 'number';
      return {
        text,
        inputTokens: data.usage?.input_tokens ?? estimateTokens(promptCharText),
        outputTokens: data.usage?.output_tokens ?? estimateTokens(text),
        usageIsEstimated: !hasRealUsage,
        citations: [],
        groundingActive: false,
      };
    }

    // OpenAI & DeepSeek
    const { endpoint } = getOpenAICompatibleEndpoint(providerId);
    const apiKey = providerId === 'openai' ? config.providers.openai : config.providers.deepseek;
    if (!apiKey) {
      throw new ProviderExecutionError(providerId, `${providerId.toUpperCase()} server credential is not configured.`, 503);
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
      signal,
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
      const errText = await res.text().catch(() => '');
      throw new ProviderExecutionError(providerId, sanitizeProviderErrorMessage(providerId, res.status, errText), res.status);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const hasRealUsage = typeof data.usage?.prompt_tokens === 'number' && typeof data.usage?.completion_tokens === 'number';

    return {
      text,
      inputTokens: data.usage?.prompt_tokens ?? estimateTokens(promptCharText),
      outputTokens: data.usage?.completion_tokens ?? estimateTokens(text),
      usageIsEstimated: !hasRealUsage,
      citations: [],
      groundingActive: false,
    };
  } catch (err) {
    if (err instanceof ProviderExecutionError) throw err;
    const raw = err instanceof Error ? err.message : '';
    throw new ProviderExecutionError(providerId, sanitizeProviderErrorMessage(providerId, 502, raw), 502);
  } finally {
    cleanup();
  }
}

export async function* parseSseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const lines = frame.split('\n');
        let eventName: string | undefined;
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join('\n') };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamProviderCompletion(params: {
  providerId: ProviderId;
  modelId: string;
  messages: ProviderMessage[];
  systemInstruction?: string;
  config: ResolvedServerConfig;
  signal?: AbortSignal;
}): AsyncGenerator<{ delta: string; done?: boolean; result?: ProviderCompletionResult }> {
  if (!isProviderEnabledForRelease(params.providerId)) {
    throw new ProviderExecutionError(
      params.providerId,
      `Provider "${params.providerId}" is disabled for the initial release.`,
      503,
    );
  }

  const promptCharText = params.messages.map((m) => m.content).join(' ');
  const { signal, cleanup } = withTimeoutSignal(params.signal, 60_000);

  try {
    // 1. Google Gemini Native Stream
    if (params.providerId === 'gemini') {
      const apiKey = params.config.providers.gemini;
      if (!apiKey) {
        throw new ProviderExecutionError('gemini', 'Google Gemini server credential is not configured.', 503);
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
        let promptTokens: number | undefined;
        let outputTokens: number | undefined;

        for await (const chunk of stream) {
          if (signal.aborted) break;
          const delta = chunk.text || '';
          if (delta) {
            fullText += delta;
            yield { delta };
          }
          const usage = (chunk as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
          if (typeof usage?.promptTokenCount === 'number') promptTokens = usage.promptTokenCount;
          if (typeof usage?.candidatesTokenCount === 'number') outputTokens = usage.candidatesTokenCount;
        }

        const hasRealUsage = typeof promptTokens === 'number' && typeof outputTokens === 'number';
        yield {
          delta: '',
          done: true,
          result: {
            text: fullText,
            inputTokens: promptTokens ?? estimateTokens(promptCharText),
            outputTokens: outputTokens ?? estimateTokens(fullText),
            usageIsEstimated: !hasRealUsage,
            citations: [],
            groundingActive: false,
          },
        };
        return;
      } catch (err) {
        const raw = err instanceof Error ? err.message : '';
        const status = raw.includes('403') || raw.includes('PERMISSION_DENIED') ? 403 : raw.includes('429') ? 429 : 502;
        throw new ProviderExecutionError('gemini', sanitizeProviderErrorMessage('gemini', status, raw), status);
      }
    }

    // 2. Anthropic Claude Native SSE Stream
    if (params.providerId === 'anthropic') {
      const apiKey = params.config.providers.anthropic;
      if (!apiKey) {
        throw new ProviderExecutionError('anthropic', 'Anthropic Claude server credential is not configured.', 503);
      }

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: params.modelId,
          max_tokens: 4096,
          stream: true,
          ...(params.systemInstruction ? { system: params.systemInstruction } : {}),
          messages: params.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        throw new ProviderExecutionError('anthropic', sanitizeProviderErrorMessage('anthropic', res.status, errText), res.status);
      }

      let fullText = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      for await (const frame of parseSseLines(res.body)) {
        if (signal.aborted) break;
        if (frame.data === '[DONE]') break;
        let payload: {
          type?: string;
          message?: { usage?: { input_tokens?: number } };
          delta?: { type?: string; text?: string };
          usage?: { output_tokens?: number };
        };
        try {
          payload = JSON.parse(frame.data);
        } catch {
          continue;
        }

        if (payload.type === 'message_start' && typeof payload.message?.usage?.input_tokens === 'number') {
          inputTokens = payload.message.usage.input_tokens;
        } else if (payload.type === 'content_block_delta' && payload.delta?.text) {
          fullText += payload.delta.text;
          yield { delta: payload.delta.text };
        } else if (payload.type === 'message_delta' && typeof payload.usage?.output_tokens === 'number') {
          outputTokens = payload.usage.output_tokens;
        }
      }

      const hasRealUsage = typeof inputTokens === 'number' && typeof outputTokens === 'number';
      yield {
        delta: '',
        done: true,
        result: {
          text: fullText,
          inputTokens: inputTokens ?? estimateTokens(promptCharText),
          outputTokens: outputTokens ?? estimateTokens(fullText),
          usageIsEstimated: !hasRealUsage,
          citations: [],
          groundingActive: false,
        },
      };
      return;
    }

    // 3. OpenAI & DeepSeek Native SSE Stream
    const { endpoint } = getOpenAICompatibleEndpoint(params.providerId);
    const apiKey = params.providerId === 'openai' ? params.config.providers.openai : params.config.providers.deepseek;
    if (!apiKey) {
      throw new ProviderExecutionError(
        params.providerId,
        `${params.providerId.toUpperCase()} server credential is not configured.`,
        503,
      );
    }

    const chatMessages: ProviderMessage[] = [];
    if (params.systemInstruction) {
      chatMessages.push({ role: 'system', content: params.systemInstruction });
    }
    for (const m of params.messages) {
      if (m.role !== 'system') chatMessages.push(m);
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.modelId,
        stream: true,
        stream_options: { include_usage: true },
        messages: chatMessages,
      }),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new ProviderExecutionError(
        params.providerId,
        sanitizeProviderErrorMessage(params.providerId, res.status, errText),
        res.status,
      );
    }

    let fullText = '';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const frame of parseSseLines(res.body)) {
      if (signal.aborted) break;
      if (frame.data === '[DONE]') break;
      let payload: {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        payload = JSON.parse(frame.data);
      } catch {
        continue;
      }

      const delta = payload.choices?.[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        yield { delta };
      }
      if (typeof payload.usage?.prompt_tokens === 'number') inputTokens = payload.usage.prompt_tokens;
      if (typeof payload.usage?.completion_tokens === 'number') outputTokens = payload.usage.completion_tokens;
    }

    const hasRealUsage = typeof inputTokens === 'number' && typeof outputTokens === 'number';
    yield {
      delta: '',
      done: true,
      result: {
        text: fullText,
        inputTokens: inputTokens ?? estimateTokens(promptCharText),
        outputTokens: outputTokens ?? estimateTokens(fullText),
        usageIsEstimated: !hasRealUsage,
        citations: [],
        groundingActive: false,
      },
    };
  } catch (err) {
    if (err instanceof ProviderExecutionError) throw err;
    const raw = err instanceof Error ? err.message : '';
    throw new ProviderExecutionError(params.providerId, sanitizeProviderErrorMessage(params.providerId, 502, raw), 502);
  } finally {
    cleanup();
  }
}

export async function probeProviderConnectivity(
  providerId: ProviderId,
  config: ResolvedServerConfig,
): Promise<{ id: ProviderId; configured: boolean; reachable: boolean | null; statusCode?: number; detail: string }> {
  if (!isProviderEnabledForRelease(providerId)) {
    return { id: providerId, configured: false, reachable: null, detail: 'Disabled for initial release.' };
  }

  const { signal, cleanup } = withTimeoutSignal(undefined, 6_000);
  try {
    if (providerId === 'gemini') {
      if (!config.providers.gemini) return { id: 'gemini', configured: false, reachable: null, detail: 'No key configured.' };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(config.providers.gemini)}`, {
        signal,
        headers: { 'User-Agent': 'aistudio-build' },
      });
      return {
        id: 'gemini',
        configured: true,
        reachable: res.ok,
        statusCode: res.status,
        detail: res.ok ? 'Gemini API reachable and key accepted.' : sanitizeProviderErrorMessage('gemini', res.status),
      };
    }

    if (providerId === 'openai') {
      if (!config.providers.openai) return { id: 'openai', configured: false, reachable: null, detail: 'No key configured.' };
      const res = await fetch('https://api.openai.com/v1/models', {
        signal,
        headers: { Authorization: `Bearer ${config.providers.openai}` },
      });
      return {
        id: 'openai',
        configured: true,
        reachable: res.ok,
        statusCode: res.status,
        detail: res.ok ? 'OpenAI API reachable and key accepted.' : sanitizeProviderErrorMessage('openai', res.status),
      };
    }

    if (providerId === 'anthropic') {
      if (!config.providers.anthropic) return { id: 'anthropic', configured: false, reachable: null, detail: 'No key configured.' };
      const res = await fetch('https://api.anthropic.com/v1/models', {
        signal,
        headers: {
          'x-api-key': config.providers.anthropic,
          'anthropic-version': '2023-06-01',
        },
      });
      return {
        id: 'anthropic',
        configured: true,
        reachable: res.ok,
        statusCode: res.status,
        detail: res.ok ? 'Anthropic API reachable and key accepted.' : sanitizeProviderErrorMessage('anthropic', res.status),
      };
    }

    if (!config.providers.deepseek) return { id: 'deepseek', configured: false, reachable: null, detail: 'No key configured.' };
    const res = await fetch('https://api.deepseek.com/models', {
      signal,
      headers: { Authorization: `Bearer ${config.providers.deepseek}` },
    });
    return {
      id: 'deepseek',
      configured: true,
      reachable: res.ok,
      statusCode: res.status,
      detail: res.ok ? 'DeepSeek API reachable and key accepted.' : sanitizeProviderErrorMessage('deepseek', res.status),
    };
  } catch {
    return {
      id: providerId,
      configured: true,
      reachable: false,
      detail: sanitizeProviderErrorMessage(providerId, 502, 'timeout'),
    };
  } finally {
    cleanup();
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
