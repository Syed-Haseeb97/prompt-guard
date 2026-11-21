import path from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import type { ProviderConfig } from './types.js';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { providerConfigSchema } from './config.js';

export const BENCHMARK_FILE_SUFFIX = '.benchmark.json';

export const benchmarkSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    /** Suite files (or globs) covered by this benchmark. */
    suites: z.array(z.string()).default([]),
    /** Providers used by the benchmark. */
    providers: z.record(providerConfigSchema).default({}),
    /** Provider used when a fixture does not name one. */
    defaultProvider: z.string().optional(),
    /** Model pinned by the benchmark. */
    model: z.string().optional(),
    /** Acceptance thresholds checked after the run. */
    thresholds: z
      .object({
        /** Minimum acceptable pass rate between 0 and 1. */
        passRate: z.number().min(0).max(1).optional(),
        /** Maximum acceptable number of failing cases. */
        maxFailures: z.number().int().min(0).optional(),
        /** Maximum acceptable number of errored cases. */
        maxErrors: z.number().int().min(0).optional(),
        /** Maximum acceptable number of newly failing cases versus a baseline. */
        maxRegressions: z.number().int().min(0).optional(),
        /** Per-tag minimum pass rates. */
        byTag: z.record(z.number().min(0).max(1)).optional(),
      })
      .default({}),
    /** Resource budgets checked after the run. */
    budgets: z
      .object({
        /** Maximum acceptable duration for the whole run, in milliseconds. */
        maxDurationMs: z.number().int().positive().optional(),
        /** Maximum acceptable duration for a single case, in milliseconds. */
        maxCaseDurationMs: z.number().int().positive().optional(),
      })
      .default({}),
    /** Labels of tags that must be present in the run. */
    requiredTags: z.array(z.string()).optional(),
  })
  .strict();

export interface BenchmarkConfig {
  $schema?: string;
  name: string;
  description?: string;
  suites: string[];
  providers: Record<string, ProviderConfig>;
  defaultProvider?: string;
  model?: string;
  thresholds: {
    passRate?: number;
    maxFailures?: number;
    maxErrors?: number;
    maxRegressions?: number;
    byTag?: Record<string, number>;
  };
  budgets: {
    maxDurationMs?: number;
    maxCaseDurationMs?: number;
  };
  requiredTags?: string[];
}

/** Validate a parsed benchmark file. */
export function validateBenchmark(raw: unknown, source: string): BenchmarkConfig {
  const result = benchmarkSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid benchmark file ${source}:\n${issues}`, { source });
  }
  return result.data as BenchmarkConfig;
}

/** Load and validate a benchmark file. */
export async function loadBenchmark(filePath: string, cwd = process.cwd()): Promise<{
  benchmark: BenchmarkConfig;
  path: string;
}> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  if (!(await pathExists(absolute))) {
    throw new ConfigError(`Benchmark file not found: ${absolute}`, { path: absolute });
  }
  const raw = await readJsonFile<unknown>(absolute);
  return { benchmark: validateBenchmark(raw, absolute), path: absolute };
}

export interface ThresholdViolation {
  kind: 'threshold' | 'budget' | 'coverage';
  message: string;
}

export interface ThresholdEvaluation {
  passed: boolean;
  violations: ThresholdViolation[];
}

/**
 * Evaluate the acceptance thresholds and budgets of a benchmark against a
 * finished run.
 */
export function evaluateThresholds(
  benchmark: BenchmarkConfig,
  run: {
    totals: { total: number; passed: number; failed: number; errored: number; skipped: number; durationMs: number };
    summary: { passRate: number; byTag: Record<string, { total: number; passed: number; passRate: number }> };
    results: Array<{ id: string; suite: string; durationMs: number; tags: string[] }>;
  },
  options: { regressions?: number } = {},
): ThresholdEvaluation {
  const violations: ThresholdViolation[] = [];
  const { thresholds, budgets } = benchmark;

  if (thresholds.passRate !== undefined && run.summary.passRate < thresholds.passRate) {
    violations.push({
      kind: 'threshold',
      message: `pass rate ${(run.summary.passRate * 100).toFixed(1)}% is below the required ${(
        thresholds.passRate * 100
      ).toFixed(1)}%`,
    });
  }

  if (thresholds.maxFailures !== undefined && run.totals.failed > thresholds.maxFailures) {
    violations.push({
      kind: 'threshold',
      message: `${run.totals.failed} failing case(s) exceed the allowed maximum of ${thresholds.maxFailures}`,
    });
  }

  if (thresholds.maxErrors !== undefined && run.totals.errored > thresholds.maxErrors) {
    violations.push({
      kind: 'threshold',
      message: `${run.totals.errored} errored case(s) exceed the allowed maximum of ${thresholds.maxErrors}`,
    });
  }

  const regressions = options.regressions ?? 0;
  if (thresholds.maxRegressions !== undefined && regressions > thresholds.maxRegressions) {
    violations.push({
      kind: 'threshold',
      message: `${regressions} regression(s) exceed the allowed maximum of ${thresholds.maxRegressions}`,
    });
  }

  for (const [tag, minimum] of Object.entries(thresholds.byTag ?? {})) {
    const stats = run.summary.byTag[tag];
    if (!stats) {
      violations.push({
        kind: 'coverage',
        message: `required tag "${tag}" has no cases in this run`,
      });
      continue;
    }
    if (stats.passRate < minimum) {
      violations.push({
        kind: 'threshold',
        message: `tag "${tag}" pass rate ${(stats.passRate * 100).toFixed(1)}% is below the required ${(
          minimum * 100
        ).toFixed(1)}%`,
      });
    }
  }

  if (budgets.maxDurationMs !== undefined && run.totals.durationMs > budgets.maxDurationMs) {
    violations.push({
      kind: 'budget',
      message: `run took ${Math.round(run.totals.durationMs)}ms, over the ${budgets.maxDurationMs}ms budget`,
    });
  }

  if (budgets.maxCaseDurationMs !== undefined) {
    for (const result of run.results) {
      if (result.durationMs > budgets.maxCaseDurationMs) {
        violations.push({
          kind: 'budget',
          message: `case "${result.suite} › ${result.id}" took ${Math.round(
            result.durationMs,
          )}ms, over the ${budgets.maxCaseDurationMs}ms budget`,
        });
      }
    }
  }

  for (const tag of benchmark.requiredTags ?? []) {
    if (!run.results.some((result) => result.tags.includes(tag))) {
      violations.push({
        kind: 'coverage',
        message: `required tag "${tag}" is not covered by any case in this run`,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}
