import { describe, expect, it } from 'vitest';
import { compareRuns, loadRunReport, resolveRunReference } from '../runner/report/compare.js';
import { toJUnitXml, runFileName } from '../runner/report/jsonReport.js';
import type { FixtureResult, RunReport } from '../core/types.js';

function makeResult(overrides: Partial<FixtureResult> = {}): FixtureResult {
  return {
    id: 'case-1',
    suite: 'demo',
    status: 'passed',
    tags: ['smoke'],
    prompt: 'hello',
    promptHash: 'hash-1',
    output: 'hello world',
    model: 'model-a',
    provider: 'mock',
    durationMs: 10,
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:01.000Z',
    assertions: [
      {
        name: 'contains',
        type: 'contains',
        status: 'passed',
        passed: true,
        message: 'ok',
        durationMs: 1,
      },
    ],
    ...overrides,
  };
}

function makeReport(
  runId: string,
  results: FixtureResult[],
  overrides: Partial<RunReport> = {},
): RunReport {
  return {
    schemaVersion: '1.0',
    runId,
    startedAt: '2024-01-01T00:00:00.000Z',
    finishedAt: '2024-01-01T00:00:01.000Z',
    durationMs: 1000,
    config: {
      suite: 'demo',
      provider: 'mock',
      model: 'model-a',
      concurrency: 2,
      timeoutMs: 1000,
      retries: 0,
      filters: {},
    },
    totals: {
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      errored: 0,
      skipped: 0,
      durationMs: 1000,
    },
    summary: { passRate: 1, byTag: {}, assertionCounts: {} },
    results,
    environment: {
      node: 'v22',
      platform: 'win32',
      arch: 'x64',
      promptGuardVersion: '1.0.0',
      cwd: '/tmp',
    },
    ...overrides,
  };
}

describe('compareRuns', () => {
  it('reports an identical pair of runs as unchanged', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [makeResult()]);
    const comparison = compareRuns(a, b);
    expect(comparison.totals.changed).toBe(0);
    expect(comparison.totals.unchanged).toBe(1);
    expect(comparison.cases[0]?.verdict).toBe('stable');
  });

  it('detects a regression when a case stops passing', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [
      makeResult({
        status: 'failed',
        output: 'totally different',
        assertions: [
          {
            name: 'contains',
            type: 'contains',
            status: 'failed',
            passed: false,
            message: 'missing',
            durationMs: 1,
          },
        ],
      }),
    ]);
    const comparison = compareRuns(a, b);
    expect(comparison.totals.regressed).toBe(1);
    expect(comparison.totals.regressedAssertions).toBe(1);
    expect(comparison.cases[0]?.verdict).toBe('regressed');
    expect(comparison.cases[0]?.assertionChanges[0]?.change).toBe('regressed');
  });

  it('detects a fix when a case starts passing', () => {
    const a = makeReport('run-a', [
      makeResult({
        status: 'failed',
        assertions: [
          {
            name: 'contains',
            type: 'contains',
            status: 'failed',
            passed: false,
            message: 'missing',
            durationMs: 1,
          },
        ],
      }),
    ]);
    const b = makeReport('run-b', [makeResult()]);
    const comparison = compareRuns(a, b);
    expect(comparison.totals.fixed).toBe(1);
    expect(comparison.cases[0]?.verdict).toBe('fixed');
  });

  it('detects prompt drift', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [makeResult({ promptHash: 'hash-2', prompt: 'changed' })]);
    const comparison = compareRuns(a, b);
    expect(comparison.drift.promptChangedCount).toBe(1);
    expect(comparison.cases[0]?.promptChanged).toBe(true);
  });

  it('detects model drift', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [
      makeResult({ model: 'model-b' }),
    ], { config: { ...makeReport('x', []).config, model: 'model-b' } });
    const comparison = compareRuns(a, b);
    expect(comparison.drift.modelChanged).toBe(true);
    expect(comparison.drift.modelB).toBe('model-b');
  });

  it('detects added and removed cases', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [makeResult(), makeResult({ id: 'case-2' })]);
    const comparison = compareRuns(a, b);
    expect(comparison.totals.added).toBe(1);

    const c = makeReport('run-c', []);
    const comparison2 = compareRuns(a, c);
    expect(comparison2.totals.removed).toBe(1);
  });

  it('counts newly added failing cases', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [makeResult(), makeResult({ id: 'case-2', status: 'failed' })]);
    const comparison = compareRuns(a, b);
    expect(comparison.totals.added).toBe(1);
    expect(comparison.totals.newFailures).toBe(1);
  });

  it('computes an output similarity score', () => {
    const a = makeReport('run-a', [makeResult({ output: 'the quick brown fox' })]);
    const b = makeReport('run-b', [makeResult({ output: 'the quick brown fox' })]);
    const comparison = compareRuns(a, b);
    expect(comparison.cases[0]?.outputSimilarity).toBeCloseTo(1, 3);
  });

  it('records assertion additions and removals', () => {
    const a = makeReport('run-a', [makeResult()]);
    const b = makeReport('run-b', [
      makeResult({
        assertions: [
          ...makeResult().assertions,
          {
            name: 'extra',
            type: 'regex',
            status: 'passed',
            passed: true,
            message: 'ok',
            durationMs: 1,
          },
        ],
      }),
    ]);
    const comparison = compareRuns(a, b);
    const added = comparison.cases[0]?.assertionChanges.find((c) => c.name === 'extra');
    expect(added?.change).toBe('added');
  });
});

describe('toJUnitXml', () => {
  it('renders a testsuites document', () => {
    const report = makeReport('run-a', [makeResult()]);
    const xml = toJUnitXml(report);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites');
    expect(xml).toContain('<testcase');
    expect(xml).toContain('</testsuites>');
  });

  it('marks failing cases with a failure element', () => {
    const report = makeReport('run-a', [makeResult({ status: 'failed' })]);
    const xml = toJUnitXml(report);
    expect(xml).toContain('<failure');
  });

  it('marks skipped cases with a skipped element', () => {
    const report = makeReport('run-a', [makeResult({ status: 'skipped' })]);
    const xml = toJUnitXml(report);
    expect(xml).toContain('<skipped/>');
  });

  it('escapes XML entities', () => {
    const report = makeReport('run-a', [
      makeResult({ title: 'a & b <c>' }),
    ]);
    const xml = toJUnitXml(report);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;c&gt;');
  });
});

describe('runFileName', () => {
  it('includes the label when present', () => {
    const report = makeReport('run-1', []);
    expect(runFileName(report, 'json')).toBe('run-1.json');
    expect(runFileName({ ...report, label: 'before' }, 'json')).toBe('run-1-before.json');
  });
});

describe('run reference resolution', () => {
  it('fails with a helpful message when the run does not exist', async () => {
    await expect(resolveRunReference('missing', 'C:\\nonexistent-output-dir')).rejects.toThrow(
      /could not resolve run/i,
    );
  });

  it('rejects files that are not run reports', async () => {
    await expect(loadRunReport('C:\\nonexistent-output-dir\\nope.json')).rejects.toThrow();
  });
});
