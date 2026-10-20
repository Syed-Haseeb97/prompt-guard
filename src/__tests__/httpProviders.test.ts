import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiProvider, HttpProvider } from '../runner/providers/openaiProvider.js';
import { AnthropicProvider } from '../runner/providers/anthropicProvider.js';
import { ProviderError } from '../core/errors.js';
import type { ProviderRequest } from '../core/types.js';

const request: ProviderRequest = {
  fixtureId: 'f1',
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'hello' }],
  prompt: 'hello',
};

function mockFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  })) as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiProvider', () => {
  it('posts to the chat completions endpoint and extracts the content', async () => {
    const fetchMock = mockFetch({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiProvider({
      config: { kind: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' },
    });
    const result = await provider.complete(request);

    expect(result.text).toBe('hi there');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.usage?.totalTokens).toBe(15);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(options.body));
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('honours a custom base url', async () => {
    const fetchMock = mockFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiProvider({
      config: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    });
    await provider.complete(request);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('sends the api key as a bearer token', async () => {
    const fetchMock = mockFetch({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiProvider({
      config: { kind: 'openai', apiKeyEnv: 'PG_TEST_KEY' },
    });
    process.env.PG_TEST_KEY = 'from-env';
    await provider.complete(request);
    delete process.env.PG_TEST_KEY;

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer from-env');
  });

  it('throws a provider error for a non-2xx response', async () => {
    const fetchMock = mockFetch({ error: { message: 'bad request' } }, { ok: false, status: 400 });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiProvider({ config: { kind: 'openai', apiKey: 'k' } });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it('requires an api key for the hosted OpenAI endpoint', async () => {
    const provider = new OpenAiProvider({ config: { kind: 'openai' } });
    await expect(provider.complete(request)).rejects.toThrow(/missing API key/i);
  });
});

describe('AnthropicProvider', () => {
  it('posts to the messages endpoint and joins text blocks', async () => {
    const fetchMock = mockFetch({
      model: 'claude-3-5-sonnet-latest',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'there' },
      ],
      usage: { input_tokens: 12, output_tokens: 4 },
      stop_reason: 'end_turn',
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      config: { kind: 'anthropic', model: 'claude-3-5-sonnet-latest', apiKey: 'k' },
    });
    const result = await provider.complete(request);

    expect(result.text).toBe('Hello there');
    expect(result.usage?.totalTokens).toBe(16);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(options.body));
    expect(body.system).toContain('You are a helpful assistant.');
    expect(body.max_tokens).toBe(1024);
  });

  it('requires an api key', async () => {
    const provider = new AnthropicProvider({ config: { kind: 'anthropic' } });
    await expect(provider.complete(request)).rejects.toThrow(/missing API key/i);
  });

  it('throws a provider error for a non-2xx response', async () => {
    const fetchMock = mockFetch({ error: 'nope' }, { ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider({ config: { kind: 'anthropic', apiKey: 'k' } });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('HttpProvider', () => {
  it('sends the request template and reads the configured response path', async () => {
    const fetchMock = mockFetch({ result: { text: 'from the gateway' } });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new HttpProvider({
      config: {
        kind: 'http',
        baseUrl: 'https://gateway.test/llm',
        responsePath: 'result.text',
        requestTemplate: { user: '{{prompt}}', system: '{{system}}' },
      },
    });
    const result = await provider.complete(request);

    expect(result.text).toBe('from the gateway');
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.test/llm');
    const body = JSON.parse(String(options.body));
    expect(body.user).toBe('hello');
    expect(body.system).toBe('You are a helpful assistant.');
  });

  it('falls back to a plain prompt body when no template is given', async () => {
    const fetchMock = mockFetch({ output: 'ok' });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new HttpProvider({
      config: { kind: 'http', baseUrl: 'https://gateway.test', responsePath: 'output' },
    });
    await provider.complete(request);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(options.body));
    expect(body.prompt).toBe('hello');
  });

  it('serialises a non-string response value as JSON', async () => {
    const fetchMock = mockFetch({ output: { a: 1 } });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new HttpProvider({
      config: { kind: 'http', baseUrl: 'https://gateway.test', responsePath: 'output' },
    });
    const result = await provider.complete(request);
    expect(JSON.parse(result.text)).toEqual({ a: 1 });
  });

  it('requires a base url', async () => {
    const provider = new HttpProvider({ config: { kind: 'http' } });
    await expect(provider.complete(request)).rejects.toThrow(/baseUrl/);
  });
});
