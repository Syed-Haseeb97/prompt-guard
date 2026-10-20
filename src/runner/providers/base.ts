import type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
} from '../../core/types.js';

export type { Provider, ProviderConfig, ProviderRequest, ProviderResponse } from '../../core/types.js';

import { ProviderError } from '../../core/errors.js';

/** Resolve the API key for a provider from the config or the environment. */
export function resolveApiKey(config: ProviderConfig): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) {
    const value = process.env[config.apiKeyEnv];
    if (value) return value;
  }
  return undefined;
}

/** Build the request headers, merging the configured extras. */
export function buildHeaders(
  config: ProviderConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(config.headers ?? {}),
    ...extra,
  };
}

/** Extract a value from a nested object using a dot path. */
export function getByPath(source: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current: unknown = source;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Throw a provider error when a non-2xx response is received. */
export async function assertOk(response: Response, body: string): Promise<void> {
  if (response.ok) return;
  const snippet = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  throw new ProviderError(
    `provider request failed with status ${response.status}: ${snippet}`,
    response.status,
    { body },
  );
}
