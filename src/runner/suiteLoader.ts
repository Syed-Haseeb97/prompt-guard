import path from 'node:path';
import { z } from 'zod';
import { SuiteError } from '../core/errors.js';
import type {
  Assertion,
  PromptFixture,
  PromptMessage,
  SuiteDefaults,
  TestSuite,
} from '../core/types.js';
import { expandGlob, readJsonFile } from '../utils/fs.js';
import { hashObject } from '../utils/hash.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
});

const assertionSchema = z
  .object({
    type: z.enum(['semantic', 'regex', 'jsonSchema', 'keywords', 'contains', 'length', 'custom']),
    name: z.string().optional(),
    severity: z.enum(['error', 'warn']).optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const fixtureSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    system: z.string().optional(),
    prompt: z.union([z.string(), z.array(messageSchema)]),
    variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    assertions: z.array(assertionSchema).optional(),
    provider: z.record(z.unknown()).optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    retries: z.number().int().min(0).optional(),
    metadata: z.record(z.unknown()).optional(),
    skip: z.boolean().optional(),
    mockResponse: z.string().optional(),
    frozenOutput: z.string().optional(),
    baseline: z
      .object({ promptHash: z.string().optional(), model: z.string().optional() })
      .optional(),
  })
  .strict();

const suiteSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.number().int().optional(),
    tags: z.array(z.string()).optional(),
    defaults: z
      .object({
        assertions: z.array(assertionSchema).optional(),
        provider: z.record(z.unknown()).optional(),
        model: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
        retries: z.number().int().min(0).optional(),
        system: z.string().optional(),
      })
      .optional(),
    fixtures: z.array(fixtureSchema),
  })
  .strict();

export interface LoadedSuite {
  suite: TestSuite;
  /** Absolute path of the file the suite was read from. */
  filePath: string;
}

/** Validate a parsed suite file. */
export function validateSuite(raw: unknown, source: string): TestSuite {
  const result = suiteSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new SuiteError(`Invalid suite file ${source}:\n${issues}`, { source });
  }

  const suite = result.data as TestSuite;
  const seen = new Set<string>();
  for (const fixture of suite.fixtures) {
    if (seen.has(fixture.id)) {
      throw new SuiteError(
        `Duplicate fixture id "${fixture.id}" in suite "${suite.name}" (${source})`,
        { source, fixtureId: fixture.id },
      );
    }
    seen.add(fixture.id);
  }
  return suite;
}

/** Apply suite-level defaults to a fixture. */
export function applyDefaults(fixture: PromptFixture, defaults: SuiteDefaults = {}): PromptFixture {
  const merged: PromptFixture = {
    ...fixture,
    system: fixture.system ?? defaults.system,
    model: fixture.model ?? defaults.model,
    timeoutMs: fixture.timeoutMs ?? defaults.timeoutMs,
    retries: fixture.retries ?? defaults.retries,
    provider: { ...(defaults.provider ?? {}), ...(fixture.provider ?? {}) },
  };
  if (defaults.assertions && defaults.assertions.length > 0) {
    // Fixture-level assertions replace suite defaults entirely when present.
    merged.assertions = fixture.assertions ?? defaults.assertions;
  } else if (!merged.assertions) {
    merged.assertions = [];
  }
  return merged;
}

/** Normalise a fixture prompt into a message list plus the flat user text. */
export function normalizePrompt(
  prompt: string | PromptMessage[],
): { messages: PromptMessage[]; userPrompt: string } {
  if (typeof prompt === 'string') {
    return { messages: [{ role: 'user', content: prompt }], userPrompt: prompt };
  }
  const messages = prompt.map((m) => ({ ...m }));
  const userPrompt = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  return { messages, userPrompt };
}

/**
 * Load all suites referenced by the config.
 *
 * `sources` are paths or globs relative to `rootDir`.
 */
export async function loadSuites(
  sources: Array<string | { path: string; name?: string }>,
  rootDir: string,
): Promise<LoadedSuite[]> {
  const loaded: LoadedSuite[] = [];
  const seenFiles = new Set<string>();

  for (const source of sources) {
    const pattern = typeof source === 'string' ? source : source.path;
    const nameOverride = typeof source === 'string' ? undefined : source.name;
    const matches = await expandGlob(pattern, rootDir);
    if (matches.length === 0) {
      throw new SuiteError(
        `No suite files matched "${pattern}" (resolved against ${rootDir})`,
        { pattern, rootDir },
      );
    }
    for (const file of matches) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      const raw = await readJsonFile<unknown>(file);
      const suite = validateSuite(raw, file);
      if (nameOverride) suite.name = nameOverride;
      loaded.push({ suite, filePath: file });
    }
  }

  return loaded;
}

/** Compute a stable fingerprint for a prompt (used for drift detection). */
export function computePromptHash(fixture: PromptFixture, variables: Record<string, unknown>): string {
  const { messages, userPrompt } = normalizePrompt(fixture.prompt);
  return hashObject({
    system: fixture.system ?? null,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    userPrompt,
    variables,
  });
}

/** Resolve a suite file path relative to a root directory. */
export function resolveSuitePath(rootDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
}

export type { Assertion };
