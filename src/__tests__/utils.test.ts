import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  createStylerFromOption,
  padVisible,
  truncateVisible,
  visibleWidth,
} from '../utils/ansi.js';
import {
  ensureDir,
  expandGlob,
  listFiles,
  pathExists,
  readJsonFile,
  stripBom,
  writeJsonFile,
  writeTextFile,
} from '../utils/fs.js';
import { generateRunId, randomId } from '../utils/id.js';
import {
  renderCaseLine,
  renderFailures,
  renderSummary,
} from '../cli/output.js';
import type { FixtureResult, RunReport } from '../core/types.js';

describe('utils/ansi', () => {
  it('calculates visible width ignoring ANSI color codes', () => {
    const styler = createStylerFromOption('always');
    const colored = styler.green('hello') + ' ' + styler.bold('world');
    expect(visibleWidth('hello world')).toBe(11);
    expect(visibleWidth(colored)).toBe(11);
  });

  it('pads visible text accounting for ANSI escapes', () => {
    const styler = createStylerFromOption('always');
    const colored = styler.red('abc');
    const padded = padVisible(colored, 6);
    expect(visibleWidth(padded)).toBe(6);
    expect(padded.endsWith('   ')).toBe(true);
  });

  it('truncates visible text to maxWidth', () => {
    expect(truncateVisible('abcdefghij', 5)).toBe('abcd…');
    expect(truncateVisible('abc', 5)).toBe('abc');
    expect(truncateVisible('abc', 1)).toBe('…');
  });

  it('handles styler modes (auto, always, never)', () => {
    const neverStyler = createStylerFromOption('never');
    expect(neverStyler.green('test')).toBe('test');
    expect(neverStyler.bold('test')).toBe('test');

    const alwaysStyler = createStylerFromOption('always');
    expect(alwaysStyler.green('test')).toContain('\x1b[');
  });
});

describe('utils/fs', () => {
  it('strips BOM from UTF-8 strings', () => {
    const withBom = '\uFEFF{"hello": "world"}';
    expect(stripBom(withBom)).toBe('{"hello": "world"}');
    expect(stripBom('normal')).toBe('normal');
  });

  it('reads and writes JSON and text files with directory creation', async () => {
    const tmp = path.join(os.tmpdir(), `pg-fs-test-${Date.now()}-${randomId(4)}`);
    try {
      const jsonFile = path.join(tmp, 'sub', 'test.json');
      await writeJsonFile(jsonFile, { score: 42 });
      expect(await pathExists(jsonFile)).toBe(true);
      const read = await readJsonFile<{ score: number }>(jsonFile);
      expect(read.score).toBe(42);

      const textFile = path.join(tmp, 'sub', 'test.txt');
      await writeTextFile(textFile, 'hello prompt-guard');
      expect(await pathExists(textFile)).toBe(true);

      const files = await listFiles(tmp);
      expect(files.length).toBe(2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('expands globs relative to cwd', async () => {
    const tmp = path.join(os.tmpdir(), `pg-glob-test-${Date.now()}-${randomId(4)}`);
    try {
      await writeTextFile(path.join(tmp, 'a.suite.json'), '{}');
      await writeTextFile(path.join(tmp, 'b.suite.json'), '{}');
      await writeTextFile(path.join(tmp, 'ignore.txt'), 'txt');

      const matched = await expandGlob('*.suite.json', tmp);
      expect(matched.length).toBe(2);
      expect(matched.some((p) => p.endsWith('a.suite.json'))).toBe(true);
      expect(matched.some((p) => p.endsWith('b.suite.json'))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('utils/id', () => {
  it('generates random hex IDs', () => {
    const id1 = randomId(4);
    const id2 = randomId(4);
    expect(id1.length).toBe(6);
    expect(id2.length).toBe(6);
    expect(id1).not.toBe(id2);
  });

  it('generates run IDs formatted with timestamp and random suffix', () => {
    const runId = generateRunId(new Date('2026-11-21T12:00:00Z'));
    expect(runId.startsWith('20261121T120000Z-')).toBe(true);
  });
});

describe('cli/output', () => {
  const styler = createStylerFromOption('never');

  const mockFixtureResult: FixtureResult = {
    suite: 'smoke',
    id: 'test-case-1',
    title: 'Customer Refund Test',
    status: 'passed',
    promptHash: 'abc12345',
    promptTokensEstimated: 12,
    response: 'Here is your refund confirmation.',
    assertions: [
      {
        assertion: { type: 'contains', needle: 'refund' },
        status: 'passed',
        score: 1,
        message: 'found needle "refund"',
      },
    ],
    durationMs: 45.2,
    tags: ['billing', 'smoke'],
    startedAt: '2026-11-21T12:00:00.000Z',
    finishedAt: '2026-11-21T12:00:00.045Z',
  };

  const mockReport: RunReport = {
    schemaVersion: 1,
    id: '20261121T120000Z-abcd',
    runId: 'run-123',
    startedAt: '2026-11-21T12:00:00.000Z',
    finishedAt: '2026-11-21T12:00:01.000Z',
    durationMs: 1000,
    config: {
      suite: 'smoke',
      provider: 'mock',
      model: 'mock-model',
      concurrency: 4,
      timeoutMs: 30000,
      retries: 1,
      filters: {},
    },
    totals: {
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      skipped: 0,
      passRate: 1,
      durationMs: 1000,
    },
    summary: {
      passRate: 1,
      byTag: {
        billing: { total: 1, passed: 1, passRate: 1 },
      },
      assertionCounts: {
        contains: { total: 1, passed: 1, failed: 0, errored: 0 },
      },
    },
    results: [mockFixtureResult],
    environment: {
      node: '20.0.0',
      platform: 'win32',
      promptGuardVersion: '1.0.0',
    },
  };

  it('renders case line cleanly', () => {
    const line = renderCaseLine(mockFixtureResult, styler);
    expect(line).toContain('smoke');
    expect(line).toContain('test-case-1');
    expect(line).toContain('Customer Refund Test');
  });

  it('renders summary cleanly', () => {
    const summary = renderSummary(mockReport, styler);
    expect(summary).toContain('1/1 passed');
    expect(summary).toContain('100.0%');
  });

  it('renders failure list when tests fail', () => {
    const failedReport: RunReport = {
      ...mockReport,
      totals: { ...mockReport.totals, passed: 0, failed: 1, passRate: 0 },
      results: [
        {
          ...mockFixtureResult,
          status: 'failed',
          assertions: [
            {
              assertion: { type: 'contains', needle: 'expected_missing' },
              status: 'failed',
              score: 0,
              message: 'did not find needle',
            },
          ],
        },
      ],
    };
    const failures = renderFailures(failedReport, styler);
    expect(failures).toContain('failing case');
    expect(failures).toContain('did not find needle');
  });
});
