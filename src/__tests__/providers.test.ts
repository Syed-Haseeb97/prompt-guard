import { describe, expect, it } from 'vitest';
import { MockProvider, deterministicResponse } from '../runner/providers/mockProvider.js';
import { createProvider, createDefaultProvider } from '../runner/providers/index.js';
import { getByPath, resolveApiKey } from '../runner/providers/base.js';
import type { ProviderRequest } from '../core/types.js';

const request: ProviderRequest = {
  fixtureId: 'f1',
  messages: [{ role: 'user', content: 'hello world' }],
  prompt: 'hello world',
};

describe('MockProvider', () => {
  it('produces deterministic output for the same prompt', async () => {
    const provider = new MockProvider({ mock: { mode: 'hash', seed: 's' } });
    const first = await provider.complete(request);
    const second = await provider.complete(request);
    expect(first.text).toBe(second.text);
  });

  it('produces different output for different prompts', async () => {
    const provider = new MockProvider({ mock: { mode: 'hash', seed: 's' } });
    const a = await provider.complete(request);
    const b = await provider.complete({ ...request, prompt: 'a completely different question' });
    expect(a.text).not.toBe(b.text);
  });

  it('echoes the prompt in echo mode', async () => {
    const provider = new MockProvider({ mock: { mode: 'echo' } });
    const result = await provider.complete(request);
    expect(result.text).toBe('hello world');
  });

  it('matches rules by fixture id', async () => {
    const provider = new MockProvider({
      mock: {
        mode: 'rules',
        rules: [{ fixtureId: 'f1', response: 'rule output' }],
        defaultResponse: 'fallback',
      },
    });
    const result = await provider.complete(request);
    expect(result.text).toBe('rule output');
  });

  it('matches rules by prompt pattern', async () => {
    const provider = new MockProvider({
      mock: { mode: 'rules', rules: [{ match: 'hello', response: 'matched' }] },
    });
    const result = await provider.complete(request);
    expect(result.text).toBe('matched');
  });

  it('falls back to the default response', async () => {
    const provider = new MockProvider({
      mock: { mode: 'rules', rules: [], defaultResponse: 'fallback' },
    });
    const result = await provider.complete(request);
    expect(result.text).toBe('fallback');
  });

  it('serialises JSON rules', async () => {
    const provider = new MockProvider({
      mock: { mode: 'rules', rules: [{ fixtureId: 'f1', json: { a: 1 } }] },
    });
    const result = await provider.complete(request);
    expect(JSON.parse(result.text)).toEqual({ a: 1 });
  });

  it('simulates provider errors', async () => {
    const provider = new MockProvider({
      mock: { errors: [{ fixtureId: 'f1', message: 'boom' }] },
    });
    await expect(provider.complete(request)).rejects.toThrow('boom');
  });

  it('exposes a stable deterministic helper', () => {
    expect(deterministicResponse('abc', 'seed')).toBe(deterministicResponse('abc', 'seed'));
    expect(deterministicResponse('abc', 'seed')).not.toBe(deterministicResponse('abd', 'seed'));
  });
});

describe('createProvider', () => {
  it('creates a mock provider', () => {
    const provider = createProvider({ kind: 'mock' });
    expect(provider.kind).toBe('mock');
  });

  it('creates an echo provider', () => {
    const provider = createProvider({ kind: 'echo' });
    expect(provider.kind).toBe('echo');
  });

  it('creates an openai provider', () => {
    const provider = createProvider({ kind: 'openai', model: 'gpt-4o' });
    expect(provider.kind).toBe('openai');
    expect(provider.model).toBe('gpt-4o');
  });

  it('creates an anthropic provider', () => {
    expect(createProvider({ kind: 'anthropic' }).kind).toBe('anthropic');
  });

  it('creates an http provider', () => {
    expect(createProvider({ kind: 'http', baseUrl: 'https://example.test' }).kind).toBe('http');
  });

  it('provides a default provider', () => {
    expect(createDefaultProvider().kind).toBe('mock');
  });
});

describe('provider helpers', () => {
  it('resolves API keys from the environment', () => {
    process.env.PG_TEST_KEY = 'abc';
    expect(resolveApiKey({ kind: 'openai', apiKeyEnv: 'PG_TEST_KEY' })).toBe('abc');
    expect(resolveApiKey({ kind: 'openai', apiKey: 'inline' })).toBe('inline');
    expect(resolveApiKey({ kind: 'openai' })).toBeUndefined();
    delete process.env.PG_TEST_KEY;
  });

  it('reads nested values by path', () => {
    const payload = { choices: [{ message: { content: 'hi' } }] };
    expect(getByPath(payload, 'choices.0.message.content')).toBe('hi');
    expect(getByPath(payload, 'missing.path')).toBeUndefined();
  });
});
