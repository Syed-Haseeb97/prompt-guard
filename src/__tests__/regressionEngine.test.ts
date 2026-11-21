import { describe, expect, it, vi } from 'vitest';
import { RegressionEngine, buildSummary, resolveOutputDir } from '../runner/regressionEngine.js';
import type { PromptGuardConfig, TestSuite } from '../core/types.js';

function makeConfig(overrides: Partial<PromptGuardConfig> = {}): PromptGuardConfig {
  return {
    version: 1,
    suites: [],
    outputDir: '.prompt-guard/runs',
    providers: {
      mock: { kind: 'mock', model: 'mock-v1', mock: { mode: 'hash', seed: 'test' } },
    },
    defaultProvider: 'mock',
    defaultModel: 'mock-v1',
    concurrency: 2,
    timeoutMs: 5000,
    retries: 0,
    report: { formats: ['json'], keepRuns: 5 },
    ...overrides,
  };
}

const suite: TestSuite = {
  name: 'demo',
  defaults: {
    assertions: [{ type: 'length', name: 'non-empty', min: 1, unit: 'chars' }],
  },
  fixtures: [
    {
      id: 'passes',
      title: 'A passing case',
      prompt: 'hello world',
      frozenOutput: 'hello world',
      tags: ['smoke'],
    },
    {
      id: 'fails',
      title: 'A failing case',
      prompt: 'goodbye',
      frozenOutput: 'goodbye',
      tags: ['smoke', 'negative'],
      assertions: [{ type: 'contains', value: 'missing-token' }],
    },
    {
      id: 'skipped',
      prompt: 'skip me',
      skip: true,
    },
  ],
};

describe('RegressionEngine', () => {
  it('executes every fixture and builds a report', async () => {
    const engine = new RegressionEngine({ config: makeConfig(), suites: [suite] });
    const report = await engine.run();

    expect(report.schemaVersion).toBe('1.0');
    expect(report.runId).toMatch(/^\d{8}T\d{6}Z-/);
    expect(report.totals.total).toBe(3);
    expect(report.totals.passed).toBe(1);
    expect(report.totals.failed).toBe(1);
    expect(report.totals.skipped).toBe(1);
    expect(report.results).toHaveLength(3);
    expect(report.summary.passRate).toBeCloseTo(1 / 3, 4);
  });

  it('records assertion results for each case', async () => {
    const engine = new RegressionEngine({ config: makeConfig(), suites: [suite] });
    const report = await engine.run();

    const failing = report.results.find((r) => r.id === 'fails');
    expect(failing?.status).toBe('failed');
    expect(failing?.assertions.some((a) => a.status === 'failed')).toBe(true);

    const passing = report.results.find((r) => r.id === 'passes');
    expect(passing?.status).toBe('passed');
    expect(passing?.assertions.every((a) => a.passed)).toBe(true);
  });

  it('applies suite defaults to fixtures', async () => {
    const engine = new RegressionEngine({ config: makeConfig(), suites: [suite] });
    const report = await engine.run();
    const passing = report.results.find((r) => r.id === 'passes');
    expect(passing?.assertions.map((a) => a.name)).toContain('non-empty');
  });

  it('filters fixtures by tag', async () => {
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [suite],
      filters: { tags: ['negative'] },
    });
    const report = await engine.run();
    expect(report.totals.total).toBe(1);
    expect(report.results[0]?.id).toBe('fails');
  });

  it('filters fixtures by id', async () => {
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [suite],
      filters: { ids: ['passes'] },
    });
    const report = await engine.run();
    expect(report.totals.total).toBe(1);
  });

  it('excludes fixtures by tag', async () => {
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [suite],
      filters: { excludeTags: ['negative'] },
    });
    const report = await engine.run();
    expect(report.results.map((r) => r.id)).not.toContain('fails');
  });

  it('interpolates variables into the prompt', async () => {
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [
        {
          name: 'vars',
          fixtures: [
            {
              id: 'templated',
              prompt: 'Order {{orderId}} for {{customer}}',
              variables: { orderId: '4821', customer: 'Ada' },
              frozenOutput: 'ok',
            },
          ],
        },
      ],
    });
    const report = await engine.run();
    expect(report.results[0]?.prompt).toBe('Order 4821 for Ada');
  });

  it('exposes variables from the environment mapping', async () => {
    process.env.PG_TEST_TOKEN = 'secret-value';
    const engine = new RegressionEngine({
      config: makeConfig({ env: { token: 'PG_TEST_TOKEN' } }),
      suites: [
        {
          name: 'env',
          fixtures: [{ id: 'env-case', prompt: 'token={{token}}', frozenOutput: 'ok' }],
        },
      ],
    });
    const report = await engine.run();
    expect(report.results[0]?.prompt).toBe('token=secret-value');
    delete process.env.PG_TEST_TOKEN;
  });

  it('captures provider errors as errored cases', async () => {
    const engine = new RegressionEngine({
      config: makeConfig({
        providers: {
          mock: {
            kind: 'mock',
            model: 'mock-v1',
            mock: { mode: 'hash', errors: [{ fixtureId: 'boom', message: 'provider exploded' }] },
          },
        },
      }),
      suites: [{ name: 'err', fixtures: [{ id: 'boom', prompt: 'x' }] }],
    });
    const report = await engine.run();
    expect(report.totals.errored).toBe(1);
    expect(report.results[0]?.error?.message).toContain('provider exploded');
  });

  it('retries retryable failures', async () => {
    let attempts = 0;
    const engine = new RegressionEngine({
      config: makeConfig({ retries: 2 }),
      suites: [{ name: 'retry', fixtures: [{ id: 'r', prompt: 'x' }] }],
      provider: {
        kind: 'mock',
        model: 'mock-v1',
        async complete() {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error('rate limit exceeded');
            throw error;
          }
          return { text: 'ok', latencyMs: 0 };
        },
      },
    });
    const report = await engine.run();
    expect(attempts).toBe(3);
    expect(report.totals.passed).toBe(1);
  });

  it('emits progress events', async () => {
    const events: string[] = [];
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [suite],
      onProgress: (event) => events.push(event.type),
    });
    await engine.run();
    expect(events).toContain('run-start');
    expect(events).toContain('case-start');
    expect(events).toContain('case-end');
    expect(events).toContain('run-end');
  });

  it('produces deterministic prompt hashes for identical prompts', async () => {
    const build = (): TestSuite => ({
      name: 'hash',
      fixtures: [{ id: 'a', prompt: 'same prompt', frozenOutput: 'x' }],
    });
    const first = await new RegressionEngine({ config: makeConfig(), suites: [build()] }).run();
    const second = await new RegressionEngine({ config: makeConfig(), suites: [build()] }).run();
    expect(first.results[0]?.promptHash).toBe(second.results[0]?.promptHash);
  });

  it('changes the prompt hash when the prompt changes', async () => {
    const first = await new RegressionEngine({
      config: makeConfig(),
      suites: [{ name: 'h', fixtures: [{ id: 'a', prompt: 'one', frozenOutput: 'x' }] }],
    }).run();
    const second = await new RegressionEngine({
      config: makeConfig(),
      suites: [{ name: 'h', fixtures: [{ id: 'a', prompt: 'two', frozenOutput: 'x' }] }],
    }).run();
    expect(first.results[0]?.promptHash).not.toBe(second.results[0]?.promptHash);
  });

  it('supports custom assertion validators', async () => {
    const validators = new Map([
      [
        'shouty',
        (assertion: { options?: Record<string, unknown> }) => ({
          name: 'shouty',
          type: 'custom' as const,
          status: 'passed' as const,
          passed: true,
          message: 'always passes',
          details: assertion.options,
          durationMs: 0,
        }),
      ],
    ]);
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [
        {
          name: 'custom',
          fixtures: [
            {
              id: 'c',
              prompt: 'x',
              frozenOutput: 'x',
              assertions: [{ type: 'custom', validator: 'shouty', options: { level: 3 } }],
            },
          ],
        },
      ],
      validators,
    });
    const report = await engine.run();
    expect(report.totals.passed).toBe(1);
    expect(report.results[0]?.assertions[0]?.details).toEqual({ level: 3 });
  });

  it('reports an errored custom assertion when the validator is missing', async () => {
    const engine = new RegressionEngine({
      config: makeConfig(),
      suites: [
        {
          name: 'custom',
          fixtures: [
            {
              id: 'c',
              prompt: 'x',
              frozenOutput: 'x',
              assertions: [{ type: 'custom', validator: 'missing' }],
            },
          ],
        },
      ],
    });
    const report = await engine.run();
    expect(report.totals.errored).toBe(1);
  });

  it('honours the concurrency setting', async () => {
    const spy = vi.fn();
    const engine = new RegressionEngine({
      config: makeConfig({ concurrency: 3 }),
      suites: [suite],
      onProgress: (event) => {
        if (event.type === 'case-end') spy();
      },
    });
    await engine.run();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops after the first failure when bail is enabled', async () => {
    const bailSuite: TestSuite = {
      name: 'bail',
      fixtures: [
        {
          id: 'first',
          prompt: 'x',
          frozenOutput: 'x',
          assertions: [{ type: 'contains', value: 'never-matches' }],
        },
        { id: 'second', prompt: 'x', frozenOutput: 'x' },
        { id: 'third', prompt: 'x', frozenOutput: 'x' },
      ],
    };
    const engine = new RegressionEngine({
      config: makeConfig({ concurrency: 1 }),
      suites: [bailSuite],
      bail: true,
    });
    const report = await engine.run();
    expect(report.totals.failed).toBe(1);
    expect(report.totals.passed).toBe(0);
    // The remaining fixtures are skipped rather than executed.
    expect(report.totals.skipped).toBe(2);
  });

  it('runs every fixture when bail is disabled', async () => {
    const bailSuite: TestSuite = {
      name: 'bail',
      fixtures: [
        {
          id: 'first',
          prompt: 'x',
          frozenOutput: 'x',
          assertions: [{ type: 'contains', value: 'never-matches' }],
        },
        { id: 'second', prompt: 'x', frozenOutput: 'x' },
      ],
    };
    const engine = new RegressionEngine({
      config: makeConfig({ concurrency: 1 }),
      suites: [bailSuite],
      bail: false,
    });
    const report = await engine.run();
    expect(report.totals.failed).toBe(1);
    expect(report.totals.passed).toBe(1);
    expect(report.totals.skipped).toBe(0);
  });
});

describe('buildSummary', () => {
  it('aggregates by tag and assertion type', () => {
    const summary = buildSummary(
      [
        {
          id: 'a',
          suite: 's',
          status: 'passed',
          tags: ['x'],
          prompt: '',
          promptHash: 'h',
          provider: 'mock',
          durationMs: 1,
          startedAt: '',
          finishedAt: '',
          assertions: [
            {
              name: 'a',
              type: 'contains',
              status: 'passed',
              passed: true,
              message: '',
              durationMs: 0,
            },
          ],
        },
      ],
      { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 1 },
    );
    expect(summary.byTag.x?.passRate).toBe(1);
    expect(summary.assertionCounts.contains?.passed).toBe(1);
  });
});

describe('resolveOutputDir', () => {
  it('resolves relative output directories against the cwd', () => {
    const dir = resolveOutputDir(makeConfig(), '/tmp/project');
    expect(dir).toContain('prompt-guard');
  });
});
