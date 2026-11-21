import type { Provider, ProviderConfig } from '../../core/types.js';
import { AnthropicProvider } from './anthropicProvider.js';
import { HttpProvider, OpenAiProvider } from './openaiProvider.js';
import { MockProvider } from './mockProvider.js';
import { FreeLlmApiProvider } from './freellmapiProvider.js';

export * from './base.js';
export * from './mockProvider.js';
export * from './openaiProvider.js';
export * from './anthropicProvider.js';
export * from './freellmapiProvider.js';

/**
 * Instantiate a provider from its configuration.
 *
 * The `mock` provider is always available even when it is not declared in the
 * config file, so a fresh project can run without any credentials.
 */
export function createProvider(config: ProviderConfig, name: string = config.kind): Provider {
  switch (config.kind) {
    case 'mock':
      return new MockProvider({ mock: config.mock, model: config.model });
    case 'openai':
      return new OpenAiProvider({ config });
    case 'freellmapi':
      return new FreeLlmApiProvider({ config });
    case 'anthropic':
      return new AnthropicProvider({ config });
    case 'http':
      return new HttpProvider({ config });
    case 'echo':
      return new MockProvider({ mock: { mode: 'echo' }, model: config.model, kind: 'echo' });
    default: {
      const exhaustive: never = config.kind;
      throw new Error(`unsupported provider kind: ${String(exhaustive)}`);
    }
  }
}

/** The provider used when nothing else is configured. */
export function createDefaultProvider(): Provider {
  return new MockProvider({ mock: { mode: 'hash' }, model: 'mock-deterministic-v1' });
}
