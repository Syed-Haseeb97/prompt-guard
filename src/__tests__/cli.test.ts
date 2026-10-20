import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../cli/index.js';

const SUITE = {
  name: 'demo',
  defaults: {
    assertions: [{ type: 'length', name: 'non-empty', min: 1, unit: 'chars' }],
  },
  fixtures: [
    {
      id: 'greeting',
      title: 'Greets the user',
      tags: ['smoke'],
      prompt: 'Say hello',
      frozenOutput: 'Hello there, how can I help?',
      assertions: [{ type: 'contains', name: 'greets', value: 'Hello' }],
    },
    {
      id: 'farewell',
      title: 'Says goodbye',
      tags: ['smoke'],
      prompt: 'Say goodbye',
      frozenOutput: 'Goodbye!',
      assertions: [{ type: 'contains', name: 'greets', value: 'Hello' }],
    },
  ],
};

const CONFIG = {
  version: 1,
  suites: ['suites/**/*.suite.json'],
  outputDir: '.prompt-guard/runs',
  providers: {
    mock: { kind: 'mock', model: 'mock-v1', mock: { mode: 'hash', seed: 'cli-test' } },
  },
  defaultProvider: 'mock',
  concurrency: 2,
  timeoutMs: 5000,
  retries: 0,
  report: { formats: ['json', 'junit'], keepRuns: 10 },
  color: 'never',
};

let workdir: string;
let originalCwd: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), 'pg-cli-'));
  await writeFile(
    path.join(workdir, 'prompt-guard.config.json'),
    JSON.stringify(CONFIG, null, 2),
    'utf8',
  );
  await mkdirp(path.join(workdir, 'suites'));
  await writeFile(
    path.join(workdir, 'suites', 'demo.suite.json'),
    JSON.stringify(SUITE, null, 2),
    'utf8',
  );
  process.chdir(workdir);

  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

describe('prompt-guard CLI', () => {
  it('prints help', async () => {
    const code = await main(['help']);
    expect(code).toBe(0);
    expect(stdout).toContain('prompt-guard');
    expect(stdout).toContain('compare');
  });

  it('prints the version', async () => {
    const code = await main(['version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('returns an error code for an unknown command', async () => {
    const code = await main(['frobnicate']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown command');
  });

  it('scaffolds a project with `init`', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-init-'));
    try {
      process.chdir(dir);
      const code = await main(['init']);
      expect(code).toBe(0);
      expect(stdout).toContain('initialised');

      const files = await readdir(dir);
      expect(files).toContain('prompt-guard.config.json');
      expect(files).toContain('suites');
      expect(files).toContain('benchmarks');

      const config = JSON.parse(
        await readFile(path.join(dir, 'prompt-guard.config.json'), 'utf8'),
      );
      expect(config.version).toBe(1);
      expect(config.providers.mock.kind).toBe('mock');
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs the suite and writes a report', async () => {
    const code = await main(['run']);
    expect(code).toBe(1); // one fixture fails its assertion
    expect(stdout).toContain('passed');

    const runDir = path.join(workdir, '.prompt-guard', 'runs');
    const files = await readdir(runDir);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.xml'))).toBe(true);

    const jsonFile = files.find((f) => f.endsWith('.json')) as string;
    const report = JSON.parse(await readFile(path.join(runDir, jsonFile), 'utf8'));
    expect(report.schemaVersion).toBe('1.0');
    expect(report.totals.total).toBe(2);
    expect(report.totals.passed).toBe(1);
    expect(report.totals.failed).toBe(1);
  });

  it('prints the raw report with --json', async () => {
    const code = await main(['run', '--json']);
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.runId).toBeDefined();
    expect(report.results).toHaveLength(2);
  });

  it('filters fixtures by tag', async () => {
    await main(['run', '--json', '--tag', 'smoke']);
    const report = JSON.parse(stdout);
    expect(report.totals.total).toBe(2);
  });

  it('filters fixtures by id', async () => {
    await main(['run', '--json', '--id', 'greeting']);
    const report = JSON.parse(stdout);
    expect(report.totals.total).toBe(1);
    expect(report.results[0].id).toBe('greeting');
  });

  it('exits 0 when every case passes', async () => {
    await writeFile(
      path.join(workdir, 'suites', 'demo.suite.json'),
      JSON.stringify(
        {
          ...SUITE,
          fixtures: [SUITE.fixtures[0]],
        },
        null,
        2,
      ),
      'utf8',
    );
    const code = await main(['run']);
    expect(code).toBe(0);
  });

  it('compares two runs and reports regressions', async () => {
    // First run: the passing fixture only.
    await writeFile(
      path.join(workdir, 'suites', 'demo.suite.json'),
      JSON.stringify({ ...SUITE, fixtures: [SUITE.fixtures[0]] }, null, 2),
      'utf8',
    );
    await main(['run', '--label', 'before']);

    // Second run: the same fixture now produces the wrong output.
    await writeFile(
      path.join(workdir, 'suites', 'demo.suite.json'),
      JSON.stringify(
        {
          ...SUITE,
          fixtures: [
            {
              ...SUITE.fixtures[0],
              frozenOutput: 'Sorry, I cannot help with that.',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    await main(['run', '--label', 'after']);

    stdout = '';
    const code = await main(['compare', 'before', 'after']);
    expect(code).toBe(1);
    expect(stdout).toContain('Run comparison');
    expect(stdout).toContain('REGRESSED');
    expect(stdout).toContain('regressed');
  });

  it('flags newly added failing cases', async () => {
    await writeFile(
      path.join(workdir, 'suites', 'demo.suite.json'),
      JSON.stringify({ ...SUITE, fixtures: [SUITE.fixtures[0]] }, null, 2),
      'utf8',
    );
    await main(['run', '--label', 'before']);

    await writeFile(
      path.join(workdir, 'suites', 'demo.suite.json'),
      JSON.stringify(SUITE, null, 2),
      'utf8',
    );
    await main(['run', '--label', 'after']);

    stdout = '';
    const code = await main(['compare', 'before', 'after']);
    expect(code).toBe(1);
    expect(stdout).toContain('new failures');
  });

  it('writes a comparison report to disk', async () => {
    await main(['run', '--label', 'a']);
    await main(['run', '--label', 'b']);
    await main(['compare', 'a', 'b', '--no-fail-on-regression']);

    const runDir = path.join(workdir, '.prompt-guard', 'runs');
    const files = await readdir(runDir);
    expect(files.some((f) => f.startsWith('comparison-'))).toBe(true);
  });

  it('fails cleanly when compare is missing a run argument', async () => {
    const code = await main(['compare', 'does-not-exist']);
    expect(code).toBe(2);
    expect(stderr).toContain('requires two run references');
  });

  it('fails cleanly when a referenced run does not exist', async () => {
    const code = await main(['compare', 'does-not-exist', 'also-missing']);
    expect(code).toBe(1);
    expect(stderr).toContain('could not resolve run');
  });

  it('evaluates benchmark thresholds', async () => {
    await writeFile(
      path.join(workdir, 'bench.benchmark.json'),
      JSON.stringify(
        {
          name: 'strict',
          suites: ['suites/**/*.suite.json'],
          defaultProvider: 'mock',
          thresholds: { passRate: 1, maxFailures: 0 },
        },
        null,
        2,
      ),
      'utf8',
    );

    // One fixture fails, so the strict benchmark must be violated.
    const code = await main(['run', '--benchmark', 'bench.benchmark.json']);
    expect(code).toBe(3);
    expect(stdout).toContain('benchmark "strict" violated');
  });

  it('passes a satisfied benchmark', async () => {
    await writeFile(
      path.join(workdir, 'suites', 'demo.suite.json'),
      JSON.stringify({ ...SUITE, fixtures: [SUITE.fixtures[0]] }, null, 2),
      'utf8',
    );
    await writeFile(
      path.join(workdir, 'bench.benchmark.json'),
      JSON.stringify(
        {
          name: 'strict',
          suites: ['suites/**/*.suite.json'],
          defaultProvider: 'mock',
          thresholds: { passRate: 1, maxFailures: 0 },
        },
        null,
        2,
      ),
      'utf8',
    );
    const code = await main(['run', '--benchmark', 'bench.benchmark.json']);
    expect(code).toBe(0);
    expect(stdout).toContain('satisfied');
  });
});
