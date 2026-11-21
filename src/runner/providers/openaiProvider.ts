import type {
  Provider,
  ProviderConfig,
  ProviderKind,
  ProviderRequest,
  ProviderResponse,
} from '../../core/types.js';
import { assertOk, buildHeaders, getByPath, resolveApiKey } from './base.js';

export interface OpenAiProviderOptions {
  config: ProviderConfig;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI-compatible chat completions provider.
 *
 * Works with OpenAI itself and with any endpoint that speaks the same wire
 * format (Groq, Together, Ollama, LM Studio, vLLM, OpenRouter, ...).
 */
export class OpenAiProvider implements Provider {
  readonly kind: ProviderKind = 'openai';
  readonly model?: string;
  private readonly config: ProviderConfig;

  constructor(options: OpenAiProviderOptions) {
    this.config = options.config;
    this.model = options.config.model;
  }

  private get endpoint(): string {
    const base = (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = performance.now();
    const apiKey = resolveApiKey(this.config);
    if (!apiKey && (this.config.baseUrl ?? DEFAULT_BASE_URL).includes('api.openai.com')) {
      throw new Error(
        `missing API key for provider "${this.config.kind}": set ${
          this.config.apiKeyEnv ?? 'OPENAI_API_KEY'
        }`,
      );
    }

    const messages = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model ?? 'gpt-4o-mini',
      messages,
    };
    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = request.maxTokens ?? this.config.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: buildHeaders(this.config, apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        body: JSON.stringify(body),
        signal: request.signal ?? controller.signal,
      });

      const text = await response.text();
      await assertOk(response, text);
      const payload = JSON.parse(text) as Record<string, unknown>;

      const choices = (payload.choices ?? []) as Array<Record<string, unknown>>;
      const first = choices[0] ?? {};
      const message = (first.message ?? {}) as Record<string, unknown>;
      const content = typeof message.content === 'string' ? message.content : '';

      const usage = (payload.usage ?? {}) as Record<string, unknown>;

      return {
        text: content,
        raw: payload,
        model: (payload.model as string) ?? request.model ?? this.config.model,
        usage: {
          promptTokens: usage.prompt_tokens as number | undefined,
          completionTokens: usage.completion_tokens as number | undefined,
          totalTokens: usage.total_tokens as number | undefined,
        },
        latencyMs: performance.now() - startedAt,
        metadata: { finishReason: first.finish_reason, requestId: response.headers.get('x-request-id') ?? undefined },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Recursively substitute `{{prompt}}` and `{{system}}` placeholders inside a
 * request template. String values are substituted in place, so the result
 * stays valid JSON.
 */
export function applyRequestTemplate(
  template: unknown,
  variables: Record<string, string>,
): unknown {
  if (typeof template === 'string') {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
      const value = variables[name];
      return value === undefined ? match : value;
    });
  }
  if (Array.isArray(template)) {
    return template.map((item) => applyRequestTemplate(item, variables));
  }
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      out[key] = applyRequestTemplate(value, variables);
    }
    return out;
  }
  return template;
}

/**
 * Generic HTTP provider. The request body is built from a template and the
 * response text is read from a configurable JSON path.
 */
export class HttpProvider implements Provider {
  readonly kind = 'http' as const;
  readonly model?: string;
  private readonly config: ProviderConfig;

  constructor(options: { config: ProviderConfig }) {
    this.config = options.config;
    this.model = options.config.model;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = performance.now();
    if (!this.config.baseUrl) {
      throw new Error('http provider requires a "baseUrl"');
    }
    const apiKey = resolveApiKey(this.config);

    const template = this.config.requestTemplate ?? {};
    const body = applyRequestTemplate(template, {
      prompt: request.prompt,
      system: request.system ?? '',
    }) as Record<string, unknown>;

    if (body.model === undefined && (request.model ?? this.config.model)) {
      body.model = request.model ?? this.config.model;
    }
    if (body.prompt === undefined && body.messages === undefined) {
      body.prompt = request.prompt;
    }

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: buildHeaders(this.config, apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        body: JSON.stringify(body),
        signal: request.signal ?? controller.signal,
      });

      const text = await response.text();
      await assertOk(response, text);

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }

      const path = this.config.responsePath ?? 'output';
      const extracted = getByPath(payload, path);
      const output =
        typeof extracted === 'string'
          ? extracted
          : extracted === undefined
            ? ''
            : JSON.stringify(extracted, null, 2);

      return {
        text: output,
        raw: payload,
        model: request.model ?? this.config.model,
        latencyMs: performance.now() - startedAt,
        metadata: { responsePath: path },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
