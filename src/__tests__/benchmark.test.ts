import { describe, expect, it } from 'vitest';
import {
  evaluateThresholds,
  loadBenchmark,
  validateBenchmark,
} from '../core/benchmark.js';
import { ConfigError } from '../core/errors.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VALID = {
  name: 'baseline',
  suites: ['suites/**/*.suite.json'],
  providers: { mock: { kind: 'mock', model: 'mock-v1' } },
  defaultProvider: 'mock',
  model: 'mock-v1',
  thresholds: { passRate: 0.95, maxFailures: 0 },
  budgets: { maxDurationMs: 60000 },
};

const RUN = {
  totals: { total: 10, passed: 10, failed: 0, errored: 0, skipped: 0, durationMs: 1200 },
  summary: {
    passRate: 1,
    byTag: { smoke: { total: 4, passed: 4, passRate: 1 } },
  },
  results: [
    { id: 'a', suite: 'demo', durationMs: 100, tags: ['smoke'] },
    { id: 'b', suite: 'demo', durationMs: 200, tags: ['billing'] },
  ],
};

describe('validateBenchmark', () => {
  it('accepts a valid benchmark', () => {
    const benchmark = validateBenchmark(VALID, 'test');
    expect(benchmark.name).toBe('baseline');
    expect(benchmark.thresholds.passRate).toBe(0.95);
  });

  it('applies defaults', () => {
    const benchmark = validateBenchmark({ name: 'minimal' }, 'test');
    expect(benchmark.suites).toEqual([]);
    expect(benchmark.thresholds).toEqual({});
    expect(benchmark.budgets).toEqual({});
  });

  it('rejects invalid benchmarks', () => {
    expect(() => validateBenchmark({ name: '' }, 'test')).toThrow(ConfigError);
    expect(() => validateBenchmark({ name: 'x', nope: 1 }, 'test')).toThrow(/Invalid benchmark/);
    expect(() => validateBenchmark({ name: 'x', thresholds: { passRate: 5 } }, 'test')).toThrow(
      ConfigError,
    );
  });
});

describe('evaluateThresholds', () => {
  it('passes when every threshold is met', () => {
    const benchmark = validateBenchmark(VALID, 'test');
    const result = evaluateThresholds(benchmark, RUN);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('fails when the pass rate is too low', () => {
    const benchmark = validateBenchmark(
      { ...VALID, thresholds: { passRate: 1 } },
      'test',
    );
    const result = evaluateThresholds(benchmark, {
      ...RUN,
      totals: { ...RUN.totals, passed: 8 },
      summary: { ...RUN.summary, passRate: 0.8 },
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.message).toContain('pass rate');
  });

  it('fails when too many cases fail', () => {
    const benchmark = validateBenchmark(VALID, 'test');
    const result = evaluateThresholds(benchmark, {
      ...RUN,
      totals: { ...RUN.totals, failed: 3 },
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.message).toContain('failing case');
  });

  it('fails when errors exceed the allowance', () => {
    const benchmark = validateBenchmark(
      { ...VALID, thresholds: { maxErrors: 0 } },
      'test',
    );
    const result = evaluateThresholds(benchmark, {
      ...RUN,
      totals: { ...RUN.totals, errored: 1 },
    });
    expect(result.passed).toBe(false);
  });

  it('fails when regressions exceed the allowance', () => {
    const benchmark = validateBenchmark(
      { ...VALID, thresholds: { maxRegressions: 0 } },
      'test',
    );
    const result = evaluateThresholds(benchmark, RUN, { regressions: 2 });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.message).toContain('regression');
  });

  it('enforces per-tag thresholds', () => {
    const benchmark = validateBenchmark(
      { ...VALID, thresholds: { byTag: { smoke: 1 } } },
      'test',
    );
    const result = evaluateThresholds(benchmark, {
      ...RUN,
      summary: { passRate: 1, byTag: { smoke: { total: 4, passed: 2, passRate: 0.5 } } },
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.message).toContain('tag "smoke"');
  });

  it('reports a missing required tag', () => {
    const benchmark = validateBenchmark(
      { ...VALID, requiredTags: ['missing'] },
      'test',
    );
    const result = evaluateThresholds(benchmark, RUN);
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.kind).toBe('coverage');
  });

  it('enforces the duration budget', () => {
    const benchmark = validateBenchmark(VALID, 'test');
    const result = evaluateThresholds(benchmark, {
      ...RUN,
      totals: { ...RUN.totals, durationMs: 120000 },
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.kind).toBe('budget');
  });

  it('enforces the per-case duration budget', () => {
    const benchmark = validateBenchmark(
      { ...VALID, budgets: { maxCaseDurationMs: 100 } },
      'test',
    );
    const result = evaluateThresholds(benchmark, RUN);
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.message).toContain('case "demo › b"');
  });
});

describe('loadBenchmark', () => {
  it('loads a benchmark from disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-bench-'));
    try {
      const file = path.join(dir, 'test.benchmark.json');
      await writeFile(file, JSON.stringify(VALID), 'utf8');
      const { benchmark, path: resolved } = await loadBenchmark(file);
      expect(benchmark.name).toBe('baseline');
      expect(resolved).toBe(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing benchmark file', async () => {
    await expect(loadBenchmark('definitely-missing.benchmark.json')).rejects.toThrow(
      /not found/i,
    );
  });
});
