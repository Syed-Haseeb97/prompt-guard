import path from 'node:path';
import { promises as fs } from 'node:fs';
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
import { assertionSchema } from '../core/config.js';
import { renderTemplate } from './template.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  name: z.string().optional(),
});

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
    dataset: z.string().optional(),
    fixtureTemplate: fixtureSchema.partial().optional(),
    fixtures: z.array(fixtureSchema).default([]),
  })
  .strict();

export interface LoadedSuite {
  suite: TestSuite;
  /** Absolute path of the file the suite was read from. */
  filePath: string;
}

/** Lightweight CSV parser supporting quoted strings with commas and escaped quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const nextChar = clean[i + 1];

    if (insideQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i += 1;
      } else if (char === '"') {
        insideQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\r') {
        // ignore CR
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += char;
      }
    }
  }
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.replace(/^["']|["']$/g, '').trim());
  const results: Array<Record<string, string>> = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.length === 1 && row[0] === '') continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (header) {
        record[header] = row[c] ?? '';
      }
    }
    results.push(record);
  }

  return results;
}

/** Lightweight JSONL parser. */
export function parseJsonl(text: string): Array<Record<string, unknown>> {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return [];
  const lines = clean.split('\n');
  const results: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        results.push(parsed as Record<string, unknown>);
      }
    } catch {
      // skip invalid lines
    }
  }
  return results;
}

/** Expand raw dataset rows into full PromptFixtures based on a template. */
export function expandDatasetRows(
  rows: Array<Record<string, unknown>>,
  template: Partial<PromptFixture> = {},
): PromptFixture[] {
  return rows.map((row, index) => {
    const stringVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== undefined && v !== null) {
        stringVars[k] = String(v);
      }
    }

    const id = row.id
      ? String(row.id)
      : template.id
        ? renderTemplate(template.id, stringVars).text
        : `row-${index + 1}`;

    const title = row.title
      ? String(row.title)
      : template.title
        ? renderTemplate(template.title, stringVars).text
        : undefined;

    const description = row.description
      ? String(row.description)
      : template.description
        ? renderTemplate(template.description, stringVars).text
        : undefined;

    const system = row.system
      ? String(row.system)
      : template.system;

    let prompt: string | PromptMessage[];
    if (row.prompt) {
      prompt = String(row.prompt);
    } else if (template.prompt) {
      prompt = template.prompt;
    } else {
      prompt = '';
    }

    const mergedVariables: Record<string, string | number | boolean> = {
      ...(template.variables ?? {}),
    };
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        mergedVariables[k] = v;
      }
    }

    return {
      id,
      title,
      description,
      system,
      prompt,
      variables: mergedVariables,
      tags: template.tags,
      assertions: template.assertions,
      provider: template.provider,
      model: template.model,
      timeoutMs: template.timeoutMs,
      retries: template.retries,
      metadata: template.metadata,
      skip: template.skip,
      mockResponse: row.mockResponse ? String(row.mockResponse) : template.mockResponse,
      frozenOutput: row.frozenOutput ? String(row.frozenOutput) : template.frozenOutput,
    };
  });
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

      if (suite.dataset) {
        const datasetPath = path.resolve(path.dirname(file), suite.dataset);
        try {
          const content = await fs.readFile(datasetPath, 'utf8');
          const isJsonl = datasetPath.endsWith('.jsonl');
          const rows = isJsonl ? parseJsonl(content) : parseCsv(content);
          const expanded = expandDatasetRows(rows, suite.fixtureTemplate);
          suite.fixtures = [...suite.fixtures, ...expanded];
        } catch (err) {
          throw new SuiteError(
            `Failed to load dataset "${suite.dataset}" for suite "${suite.name}": ${(err as Error).message}`,
            { source: file },
          );
        }
      }

      // Re-verify uniqueness of fixture IDs after dataset expansion
      const seenIds = new Set<string>();
      for (const fixture of suite.fixtures) {
        if (seenIds.has(fixture.id)) {
          throw new SuiteError(
            `Duplicate fixture id "${fixture.id}" in suite "${suite.name}" (${file})`,
            { source: file, fixtureId: fixture.id },
          );
        }
        seenIds.add(fixture.id);
      }

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
