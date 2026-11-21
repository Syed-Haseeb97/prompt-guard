import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  RUN_REPORT_SCHEMA_VERSION,
  type Assertion,
  type AssertionResult,
  type Diagnostic,
  type EnvironmentInfo,
  type FixtureResult,
  type FixtureStatus,
  type PromptFixture,
  type PromptGuardConfig,
  type Provider,
  type ProviderConfig,
  type RunReport,
  type RunSummary,
  type RunTotals,
  type TestSuite,
} from '../core/types.js';
import { Logger, silentLogger } from '../core/logger.js';
import { ProviderError } from '../core/errors.js';
import { isRetryableError, runPool } from '../utils/async.js';
import { hashObject, shortHash } from '../utils/hash.js';
import { generateRunId } from '../utils/id.js';
import { createProvider } from './providers/index.js';
import { applyDefaults, normalizePrompt } from './suiteLoader.js';
import { VERSION } from '../version.js';
import { renderTemplate } from './template.js';
import { runAssertions } from './assertions/index.js';
import type { AssertionContext, CustomValidator, EmbeddingFunction } from './assertions/types.js';

export type ProgressEvent =
  | { type: 'run-start'; total: number; suiteCount: number }
  | { type: 'case-start'; suite: string; id: string; title?: string }
  | {
      type: 'case-end';
      suite: string;
      id: string;
      title?: string;
      status: FixtureStatus;
      durationMs: number;
      result: FixtureResult;
    }
  | { type: 'suite-end'; suite: string; passed: number; failed: number }
  | { type: 'run-end'; report: RunReport };

export interface EngineFilters {
  /** Only run fixtures carrying at least one of these tags. */
  tags?: string[];
  /** Only run these fixture ids. */
  ids?: string[];
  /** Skip fixtures carrying any of these tags. */
  excludeTags?: string[];
  /** Free text search over id/title/description. */
  search?: string;
}

export interface EngineOptions {
  /** The resolved project configuration. */
  config: PromptGuardConfig;
  /** Suites to execute. */
  suites: TestSuite[];
  /** Provider name from the config file. */
  providerName?: string;
  /** Model override applied to every fixture. */
  model?: string;
  /** Fixture filters. */
  filters?: EngineFilters;
  /** Override the configured concurrency. */
  concurrency?: number;
  /** Override the configured timeout. */
  timeoutMs?: number;
  /** Override the configured retry count. */
  retries?: number;
  /** Human readable label stored in the report. */
  label?: string;
  /** Logger for diagnostics. */
  logger?: Logger;
  /** Custom assertion validators. */
  validators?: Map<string, CustomValidator>;
  /** Optional embedding provider for semantic assertions. */
  embed?: EmbeddingFunction;
  /** Progress callback. */
  onProgress?: (event: ProgressEvent) => void;
  /** Pre-built provider instance (overrides `providerName`). */
  provider?: Provider;
  /** Directory reported in the environment block. */
  cwd?: string;
  /** Stop executing further fixtures after the first failure. */
  bail?: boolean;
}

export interface EngineRunOptions {
  /** Explicit run id (used when replaying a report). */
  runId?: string;
}

/** Collect the environment metadata stored in every report. */
export function collectEnvironment(cwd: string, version: string): EnvironmentInfo {
  let gitCommit: string | undefined;
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    gitCommit = undefined;
  }

  const info: EnvironmentInfo = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    promptGuardVersion: version,
    cwd,
  };
  if (gitCommit) info.gitCommit = gitCommit;
  return info;
}

function matchesFilters(fixture: PromptFixture, filters: EngineFilters | undefined): boolean {
  if (!filters) return true;
  const tags = fixture.tags ?? [];

  if (filters.ids && filters.ids.length > 0 && !filters.ids.includes(fixture.id)) {
    return false;
  }
  if (filters.tags && filters.tags.length > 0) {
    if (!tags.some((tag) => filters.tags?.includes(tag))) return false;
  }
  if (filters.excludeTags && filters.excludeTags.length > 0) {
    if (tags.some((tag) => filters.excludeTags?.includes(tag))) return false;
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    const haystack = [fixture.id, fixture.title ?? '', fixture.description ?? '']
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Merge suite defaults, config defaults and fixture-level settings. */
export function resolveFixture(
  suite: TestSuite,
  fixture: PromptFixture,
  config: PromptGuardConfig,
): PromptFixture {
  const withSuiteDefaults = applyDefaults(fixture, suite.defaults ?? {});
  const assertions: Assertion[] =
    withSuiteDefaults.assertions && withSuiteDefaults.assertions.length > 0
      ? withSuiteDefaults.assertions
      : (config.defaultAssertions ?? []);

  return {
    ...withSuiteDefaults,
    assertions,
    timeoutMs: withSuiteDefaults.timeoutMs ?? config.timeoutMs,
    retries: withSuiteDefaults.retries ?? config.retries,
  };
}

/**
 * The regression engine: executes prompt fixtures against LLM providers and
 * evaluates the outputs with the fuzzy assertion engines.
 */
export class RegressionEngine {
  private readonly options: EngineOptions;
  private readonly logger: Logger;
  private readonly providerCache = new Map<string, Provider>();
  private readonly diagnostics: Diagnostic[] = [];
  /** Set when `bail` triggers and remaining fixtures must be skipped. */
  private aborted = false;

  constructor(options: EngineOptions) {
    this.options = options;
    this.logger = options.logger ?? silentLogger;
  }

  private get config(): PromptGuardConfig {
    return this.options.config;
  }

  /** Resolve the provider configuration for a fixture. */
  private resolveProviderConfig(fixture: PromptFixture): { name: string; config: ProviderConfig } {
    const name = this.options.providerName ?? this.config.defaultProvider;
    const base = this.config.providers[name] ?? {
      kind: 'mock' as const,
      model: 'mock-deterministic-v1',
      mock: { mode: 'hash' as const },
    };
    const merged: ProviderConfig = { ...base, ...(fixture.provider ?? {}) };
    if (merged.mock || base.mock) {
      merged.mock = { ...(base.mock ?? {}), ...(fixture.provider?.mock ?? {}) };
    }
    if (this.options.model) merged.model = this.options.model;
    if (fixture.model) merged.model = fixture.model;
    return { name, config: merged };
  }

  private getProvider(fixture: PromptFixture): { name: string; provider: Provider } {
    if (this.options.provider) {
      return { name: this.options.providerName ?? this.config.defaultProvider, provider: this.options.provider };
    }
    const { name, config } = this.resolveProviderConfig(fixture);
    const key = JSON.stringify(config);
    let provider = this.providerCache.get(key);
    if (!provider) {
      provider = createProvider(config, name);
      this.providerCache.set(key, provider);
    }
    return { name, provider };
  }

  /** Build the variable scope for a fixture. */
  private buildVariables(fixture: PromptFixture): Record<string, string | number | boolean> {
    const fromConfig: Record<string, string | number | boolean> = {};
    for (const [key, envName] of Object.entries(this.config.env ?? {})) {
      const value = process.env[envName];
      if (value !== undefined) fromConfig[key] = value;
    }
    return { ...fromConfig, ...(fixture.variables ?? {}) };
  }

  private async executeWithRetry(
    provider: Provider,
    request: Parameters<Provider['complete']>[0],
    retries: number,
    timeoutMs: number,
  ): Promise<Awaited<ReturnType<Provider['complete']>>> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= retries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      try {
        const promise = provider.complete({ ...request, signal: controller.signal });
        const result = await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(new ProviderError(`request timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
            if (typeof t.unref === 'function') t.unref();
          }),
        ]);
        clearTimeout(timer);
        return result;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        const isTimeout = (error as Error)?.name === 'AbortError' || (error as Error)?.message?.includes('timed out');
        if (attempt >= retries || (!isTimeout && !isRetryableError(error))) break;
        attempt += 1;
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        this.logger.warn(
          `retrying after error: ${(error as Error).message}`,
          'PG_RETRY',
        );
        await new Promise((resolve) => {
          const t = setTimeout(resolve, backoff);
          if (typeof t.unref === 'function') t.unref();
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderError(`provider call failed: ${String(lastError)}`);
  }

  private async runFixture(
    suite: TestSuite,
    fixture: PromptFixture,
  ): Promise<FixtureResult> {
    const startedAt = new Date();
    const startedAtMs = performance.now();
    const resolved = resolveFixture(suite, fixture, this.config);
    const variables = this.buildVariables(resolved);
    const { messages, userPrompt } = normalizePrompt(resolved.prompt);

    const renderedMessages = messages.map((message) => ({
      ...message,
      content: renderTemplate(message.content, variables).text,
    }));
    const renderedSystem = resolved.system
      ? renderTemplate(resolved.system, variables).text
      : undefined;
    const renderedUserPrompt = renderedMessages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');

    const promptHash = shortHash(
      hashObject({
        system: renderedSystem ?? null,
        messages: renderedMessages.map((m) => ({ role: m.role, content: m.content })),
      }),
    );

    const { name: providerName, provider } = this.getProvider(resolved);

    const base: FixtureResult = {
      id: resolved.id,
      title: resolved.title,
      suite: suite.name,
      status: 'skipped',
      tags: resolved.tags ?? [],
      prompt: renderedUserPrompt,
      system: renderedSystem,
      promptHash,
      model: resolved.model ?? provider.model,
      provider: providerName,
      durationMs: 0,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      assertions: [],
      metadata: resolved.metadata,
    };

    if (resolved.skip) {
      base.status = 'skipped';
      base.finishedAt = new Date().toISOString();
      base.durationMs = Number((performance.now() - startedAtMs).toFixed(3));
      return base;
    }

    if (this.aborted) {
      base.status = 'skipped';
      base.finishedAt = new Date().toISOString();
      base.durationMs = Number((performance.now() - startedAtMs).toFixed(3));
      return base;
    }

    let output: string;
    try {
      if (resolved.frozenOutput !== undefined) {
        output = resolved.frozenOutput;
      } else {
        const response = await this.executeWithRetry(
          provider,
          {
            fixtureId: resolved.id,
            system: renderedSystem,
            messages: renderedMessages,
            prompt: renderedUserPrompt,
            model: resolved.model,
            temperature: providerName ? this.config.providers[providerName]?.temperature : undefined,
            maxTokens: providerName ? this.config.providers[providerName]?.maxTokens : undefined,
            timeoutMs: resolved.timeoutMs,
            mockResponse: resolved.mockResponse,
          },
          resolved.retries ?? 0,
          resolved.timeoutMs ?? 30_000,
        );
        output = response.text;
        base.model = response.model ?? base.model;
        if (response.usage) {
          base.metadata = { ...(base.metadata ?? {}), usage: response.usage };
        }
      }
    } catch (error) {
      base.status = 'errored';
      base.error = {
        message: (error as Error).message,
        name: (error as Error).name ?? 'Error',
        stack: (error as Error).stack,
      };
      base.finishedAt = new Date().toISOString();
      base.durationMs = Number((performance.now() - startedAtMs).toFixed(3));
      return base;
    }

    base.output = output;

    const context: AssertionContext = {
      output,
      fixture: resolved,
      suite,
      variables,
      validators: this.options.validators ?? new Map(),
      embed: this.options.embed,
      logger: this.logger,
    };

    let assertionResults: AssertionResult[];
    try {
      assertionResults = await runAssertions(resolved.assertions ?? [], context);
    } catch (error) {
      assertionResults = [
        {
          name: 'assertion-engine',
          type: 'custom',
          status: 'errored',
          passed: false,
          message: `assertion engine failed: ${(error as Error).message}`,
          durationMs: 0,
        },
      ];
    }

    base.assertions = assertionResults;
    // A harness/validator error is reported as `errored`, an unmet
    // expectation as `failed` — the distinction matters when triaging a
    // regression.
    const hasErrored = assertionResults.some((r) => r.status === 'errored');
    const hasFailed = assertionResults.some((r) => r.status === 'failed');
    base.status = hasErrored ? 'errored' : hasFailed ? 'failed' : 'passed';
    if (base.status !== 'passed' && (this.options.bail ?? this.config.bail)) {
      this.aborted = true;
    }
    base.finishedAt = new Date().toISOString();
    base.durationMs = Number((performance.now() - startedAtMs).toFixed(3));
    return base;
  }

  /** Execute every selected fixture and produce a run report. */
  async run(options: EngineRunOptions = {}): Promise<RunReport> {
    const runId = options.runId ?? generateRunId();
    const startedAt = new Date();
    const startedAtMs = performance.now();
    const onProgress = this.options.onProgress;

    const tasks: Array<() => Promise<FixtureResult>> = [];
    const selectedSuites: Array<{ suite: TestSuite; count: number }> = [];

    for (const suite of this.options.suites) {
      let count = 0;
      for (const fixture of suite.fixtures) {
        if (!matchesFilters(fixture, this.options.filters)) continue;
        count += 1;
        tasks.push(async () => {
          onProgress?.({
            type: 'case-start',
            suite: suite.name,
            id: fixture.id,
            title: fixture.title,
          });
          const result = await this.runFixture(suite, fixture);
          onProgress?.({
            type: 'case-end',
            suite: result.suite,
            id: result.id,
            title: result.title,
            status: result.status,
            durationMs: result.durationMs,
            result,
          });
          return result;
        });
      }
      selectedSuites.push({ suite, count });
    }

    onProgress?.({
      type: 'run-start',
      total: tasks.length,
      suiteCount: selectedSuites.length,
    });

    const results = await runPool(tasks, this.options.concurrency ?? this.config.concurrency);

    // Restore suite grouping order for stable reporting.
    const ordered: FixtureResult[] = [];
    let cursor = 0;
    for (const { suite, count } of selectedSuites) {
      for (let i = 0; i < count; i += 1) {
        const result = results[cursor];
        cursor += 1;
        if (!result) continue;
        ordered.push(result);
      }
    }

    for (const { suite } of selectedSuites) {
      const suiteResults = ordered.filter((r) => r.suite === suite.name);
      onProgress?.({
        type: 'suite-end',
        suite: suite.name,
        passed: suiteResults.filter((r) => r.status === 'passed').length,
        failed: suiteResults.filter((r) => r.status === 'failed' || r.status === 'errored').length,
      });
    }

    const finishedAt = new Date();
    const durationMs = Number((performance.now() - startedAtMs).toFixed(3));

    const totals: RunTotals = {
      total: ordered.length,
      passed: ordered.filter((r) => r.status === 'passed').length,
      failed: ordered.filter((r) => r.status === 'failed').length,
      errored: ordered.filter((r) => r.status === 'errored').length,
      skipped: ordered.filter((r) => r.status === 'skipped').length,
      durationMs,
    };

    const report: RunReport = {
      schemaVersion: RUN_REPORT_SCHEMA_VERSION,
      runId,
      label: this.options.label,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      config: {
        suite: selectedSuites.map((s) => s.suite.name).join(', '),
        provider: this.options.providerName ?? this.config.defaultProvider,
        model: this.options.model ?? this.config.defaultModel,
        concurrency: this.options.concurrency ?? this.config.concurrency,
        timeoutMs: this.options.timeoutMs ?? this.config.timeoutMs,
        retries: this.options.retries ?? this.config.retries,
        filters: {
          tags: this.options.filters?.tags,
          ids: this.options.filters?.ids,
        },
      },
      totals,
      summary: buildSummary(ordered, totals),
      results: ordered,
      environment: collectEnvironment(this.options.cwd ?? process.cwd(), VERSION),
    };

    onProgress?.({ type: 'run-end', report });
    return report;
  }
}

/** Aggregate per-tag and per-assertion statistics. */
export function buildSummary(results: FixtureResult[], totals: RunTotals): RunSummary {
  const byTag: RunSummary['byTag'] = {};
  const assertionCounts: RunSummary['assertionCounts'] = {};

  for (const result of results) {
    for (const tag of result.tags) {
      const bucket = (byTag[tag] ??= { total: 0, passed: 0, passRate: 0 });
      bucket.total += 1;
      if (result.status === 'passed') bucket.passed += 1;
    }
    for (const assertion of result.assertions) {
      const bucket = (assertionCounts[assertion.type] ??= { total: 0, passed: 0, failed: 0 });
      bucket.total += 1;
      if (assertion.passed) bucket.passed += 1;
      else bucket.failed += 1;
    }
  }

  for (const bucket of Object.values(byTag)) {
    bucket.passRate = bucket.total === 0 ? 0 : Number((bucket.passed / bucket.total).toFixed(4));
  }

  return {
    passRate: totals.total === 0 ? 0 : Number((totals.passed / totals.total).toFixed(4)),
    byTag,
    assertionCounts,
  };
}

/** Resolve the output directory for run artefacts. */
export function resolveOutputDir(config: PromptGuardConfig, cwd: string): string {
  return path.isAbsolute(config.outputDir) ? config.outputDir : path.resolve(cwd, config.outputDir);
}
