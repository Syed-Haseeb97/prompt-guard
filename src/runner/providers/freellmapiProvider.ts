import type { Provider, ProviderConfig, ProviderKind } from '../../core/types.js';
import { OpenAiProvider } from './openaiProvider.js';

export const DEFAULT_FREELLMAPI_BASE_URL = 'http://127.0.0.1:3001/v1';

/**
 * FreeLLMAPI provider preset.
 *
 * FreeLLMAPI is a local/remote gateway exposing an OpenAI-compatible API
 * for free-tier and multi-provider models. Defaults to http://127.0.0.1:3001/v1
 * and reads FREELLMAPI_KEY (falling back to OPENAI_API_KEY).
 */
export class FreeLlmApiProvider extends OpenAiProvider implements Provider {
  override readonly kind: ProviderKind = 'freellmapi';

  constructor(options: { config: ProviderConfig }) {
    const configWithDefaults: ProviderConfig = {
      ...options.config,
      kind: 'freellmapi',
      baseUrl: options.config.baseUrl ?? DEFAULT_FREELLMAPI_BASE_URL,
      apiKeyEnv:
        options.config.apiKeyEnv ??
        (process.env.FREELLMAPI_KEY ? 'FREELLMAPI_KEY' : 'OPENAI_API_KEY'),
    };
    super({ config: configWithDefaults });
  }
}
