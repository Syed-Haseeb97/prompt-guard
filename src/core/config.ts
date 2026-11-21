import { z } from 'zod';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';
import type { PromptGuardConfig, ProviderConfig } from './types.js';

export const CONFIG_FILE_NAMES = [
  'prompt-guard.config.json',
  '.prompt-guardrc.json',
  'prompt-guard.config.js',
] as const;

export const DEFAULT_CONFIG_FILE = 'prompt-guard.config.json';

export const providerConfigSchema = z
  .object({
    kind: z.enum(['mock', 'openai', 'anthropic', 'http', 'echo']),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    systemPrompt: z.string().optional(),
    responsePath: z.string().optional(),
    requestTemplate: z.record(z.unknown()).optional(),
    retries: z.number().int().min(0).optional(),
    mock: z
      .object({
        mode: z.enum(['hash', 'echo', 'rules']).optional(),
        seed: z.string().optional(),
        defaultResponse: z.string().optional(),
        latencyMs: z.number().int().min(0).optional(),
        rules: z
          .array(
            z.object({
              match: z.string().optional(),
              fixtureId: z.string().optional(),
              response: z.string().optional(),
              json: z.unknown().optional(),
              caseInsensitive: z.boolean().optional(),
            }),
          )
          .optional(),
        errors: z
          .array(
            z.object({
              fixtureId: z.string(),
              message: z.string(),
              status: z.number().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .strict();

export const assertionSchema = z
  .object({
    type: z.enum(['semantic', 'regex', 'jsonSchema', 'keywords', 'contains', 'length', 'custom']),
    name: z.string().optional(),
    severity: z.enum(['error', 'warn']).optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const configSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    suites: z
      .array(
        z.union([
          z.string(),
          z.object({ path: z.string(), name: z.string().optional() }),
        ]),
      )
      .default([]),
    outputDir: z.string().default('.prompt-guard/runs'),
    providers: z.record(providerConfigSchema).default({}),
    defaultProvider: z.string().default('mock'),
    defaultModel: z.string().optional(),
    concurrency: z.number().int().positive().max(256).default(4),
    timeoutMs: z.number().int().positive().default(30_000),
    retries: z.number().int().min(0).max(10).default(1),
    defaultAssertions: z.array(assertionSchema).optional(),
    report: z
      .object({
        formats: z.array(z.enum(['json', 'junit'])).default(['json']),
        keepRuns: z.number().int().min(0).default(20),
      })
      .default({ formats: ['json'], keepRuns: 20 }),
    env: z.record(z.string()).optional(),
    color: z.enum(['auto', 'always', 'never']).default('auto'),
    bail: z.boolean().default(false),
  })
  .strict();

/** Shape of the `prompt-guard init` scaffold. */
export function defaultConfig(): PromptGuardConfig {
  return {
    version: 1,
    suites: [{ path: 'suites/**/*.suite.json' }],
    outputDir: '.prompt-guard/runs',
    providers: {
      mock: {
        kind: 'mock',
        model: 'mock-deterministic-v1',
        mock: { mode: 'hash', seed: 'prompt-guard' },
      },
    },
    defaultProvider: 'mock',
    defaultModel: 'mock-deterministic-v1',
    concurrency: 4,
    timeoutMs: 30_000,
    retries: 1,
    defaultAssertions: [
      { type: 'length', name: 'non-empty response', min: 1, max: 20_000, unit: 'chars' },
    ],
    report: { formats: ['json', 'junit'], keepRuns: 20 },
    color: 'auto',
    bail: false,
  };
}

/** Locate the config file by walking up from `cwd`. */
export async function findConfigFile(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = path.join(current, name);
      if (await pathExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface LoadedConfig {
  config: PromptGuardConfig;
  /** Absolute path of the config file, when one was found. */
  configPath?: string;
  /** Absolute path of the directory the config lives in. */
  rootDir: string;
  /** Non-fatal problems found while loading. */
  warnings: string[];
}

/** Validate an already-parsed config object. */
export function validateConfig(raw: unknown, source = '<inline>'): PromptGuardConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration in ${source}:\n${issues}`, {
      source,
      issues: result.error.issues,
    });
  }

  const config = result.data as PromptGuardConfig;
  const warnings: string[] = [];

  if (!config.providers[config.defaultProvider]) {
    warnings.push(
      `defaultProvider "${config.defaultProvider}" is not defined in "providers"; ` +
        `falling back to the built-in mock provider.`,
    );
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.apiKey) {
      warnings.push(
        `provider "${name}" has an inline apiKey configured. Storing credentials in config files is discouraged; consider using "apiKeyEnv" instead to avoid accidental credential leaks.`,
      );
    }
    if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) {
      warnings.push(
        `provider "${name}" expects env var ${provider.apiKeyEnv}, which is not set.`,
      );
    }
  }
  return config;
}

/** Load and validate the config file. */
export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<LoadedConfig> {
  const warnings: string[] = [];
  let configPath: string | undefined;

  if (explicitPath) {
    configPath = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(cwd, explicitPath);
    if (!(await pathExists(configPath))) {
      throw new ConfigError(`Config file not found: ${configPath}`, { configPath });
    }
  } else {
    configPath = await findConfigFile(cwd);
  }

  if (!configPath) {
    return {
      config: defaultConfig(),
      rootDir: path.resolve(cwd),
      warnings: ['No prompt-guard config found; using built-in defaults.'],
    };
  }

  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(configPath);
  } catch (error) {
    throw new ConfigError(
      `Failed to parse config file ${configPath}: ${(error as Error).message}`,
      { configPath },
    );
  }

  const config = validateConfig(raw, configPath);
  const rootDir = path.dirname(path.resolve(configPath));
  const merged = mergeWithEnv(config, rootDir);
  return { config: merged, configPath: path.resolve(configPath), rootDir, warnings };
}

function mergeWithEnv(config: PromptGuardConfig, rootDir: string): PromptGuardConfig {
  return {
    ...config,
    outputDir: path.isAbsolute(config.outputDir)
      ? config.outputDir
      : path.join(rootDir, config.outputDir),
  };
}

/** Write a config file to disk. */
export async function saveConfig(
  targetPath: string,
  config: PromptGuardConfig = defaultConfig(),
): Promise<void> {
  await writeJsonFile(targetPath, config);
}

/** Resolve a named provider from the config, falling back to a mock provider. */
export function resolveProvider(
  config: PromptGuardConfig,
  name: string,
): { name: string; provider: ProviderConfig } {
  const provider = config.providers[name];
  if (provider) return { name, provider };
  if (name === 'mock' || name === 'default') {
    return {
      name: 'mock',
      provider: { kind: 'mock', model: 'mock-deterministic-v1', mock: { mode: 'hash' } },
    };
  }
  throw new ConfigError(
    `Unknown provider "${name}". Defined providers: ${Object.keys(config.providers).join(', ') || '(none)'}`,
    { provider: name },
  );
}
