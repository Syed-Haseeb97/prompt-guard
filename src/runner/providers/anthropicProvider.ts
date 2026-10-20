import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
} from '../../core/types.js';
import { assertOk, buildHeaders, resolveApiKey } from './base.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  config: ProviderConfig;
}

/** Anthropic Messages API provider. */
export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;
  readonly model?: string;
  private readonly config: ProviderConfig;

  constructor(options: AnthropicProviderOptions) {
    this.config = options.config;
    this.model = options.config.model;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = performance.now();
    const apiKey = resolveApiKey(this.config);
    if (!apiKey) {
      throw new Error(
        `missing API key for anthropic provider: set ${
          this.config.apiKeyEnv ?? 'ANTHROPIC_API_KEY'
        }`,
      );
    }

    const systemParts = [
      request.system ?? this.config.systemPrompt,
      ...request.messages.filter((m) => m.role === 'system').map((m) => m.content),
    ].filter((part): part is string => Boolean(part));

    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));

    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model ?? 'claude-3-5-sonnet-latest',
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 1024,
      messages: messages.length > 0 ? messages : [{ role: 'user', content: request.prompt }],
    };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    const temperature = request.temperature ?? this.config.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const response = await fetch(`${(this.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: buildHeaders(this.config, {
          'x-api-key': apiKey,
          'anthropic-version': DEFAULT_VERSION,
        }),
        body: JSON.stringify(body),
        signal: request.signal ?? controller.signal,
      });

      const text = await response.text();
      await assertOk(response, text);
      const payload = JSON.parse(text) as Record<string, unknown>;

      const content = (payload.content ?? []) as Array<Record<string, unknown>>;
      const output = content
        .filter((part) => part.type === 'text')
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('');

      const usage = (payload.usage ?? {}) as Record<string, unknown>;

      return {
        text: output,
        raw: payload,
        model: (payload.model as string) ?? request.model ?? this.config.model,
        usage: {
          promptTokens: usage.input_tokens as number | undefined,
          completionTokens: usage.output_tokens as number | undefined,
          totalTokens:
            typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
              ? usage.input_tokens + usage.output_tokens
              : undefined,
        },
        latencyMs: performance.now() - startedAt,
        metadata: { stopReason: payload.stop_reason, requestId: response.headers.get('request-id') ?? undefined },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
