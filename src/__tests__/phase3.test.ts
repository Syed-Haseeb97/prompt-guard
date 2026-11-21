import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { FreeLlmApiProvider, DEFAULT_FREELLMAPI_BASE_URL } from '../runner/providers/freellmapiProvider.js';
import { ResultCache } from '../runner/cache.js';
import { validateLlmJudge } from '../runner/assertions/llmJudge.js';
import { parseCsv, parseJsonl, expandDatasetRows, loadSuites } from '../runner/suiteLoader.js';
import { renderMatrixScorecard } from '../cli/output.js';
import { createStylerFromOption } from '../utils/ansi.js';
import { silentLogger } from '../core/logger.js';
import type { LlmJudgeAssertion, PromptFixture, TestSuite } from '../core/types.js';

describe('Phase 3: FreeLLMAPI Provider', () => {
  it('initializes with default base URL and detects API keys', () => {
    const originalKey = process.env.FREELLMAPI_KEY;
    try {
      process.env.FREELLMAPI_KEY = 'test-freellm-key';
      const provider = new FreeLlmApiProvider({
        config: {
          kind: 'freellmapi',
          model: 'meta-llama/llama-3-8b-instruct',
        },
      });

      expect(provider.kind).toBe('freellmapi');
      expect(provider.model).toBe('meta-llama/llama-3-8b-instruct');
      // @ts-expect-error accessing private property for verification
      expect(provider.config.baseUrl).toBe(DEFAULT_FREELLMAPI_BASE_URL);
      // @ts-expect-error accessing private property for verification
      expect(provider.config.apiKeyEnv).toBe('FREELLMAPI_KEY');
    } finally {
      if (originalKey === undefined) {
        delete process.env.FREELLMAPI_KEY;
      } else {
        process.env.FREELLMAPI_KEY = originalKey;
      }
    }
  });

  it('allows overriding base URL and model', () => {
    const provider = new FreeLlmApiProvider({
      config: {
        kind: 'freellmapi',
        baseUrl: 'http://custom-proxy:8080/v1',
        model: 'gemini-2.5-flash',
      },
    });

    expect(provider.kind).toBe('freellmapi');
    // @ts-expect-error accessing private property for verification
    expect(provider.config.baseUrl).toBe('http://custom-proxy:8080/v1');
    expect(provider.model).toBe('gemini-2.5-flash');
  });
});

describe('Phase 3: ResultCache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-cache-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('computes deterministic keys for identical requests', () => {
    const cache = new ResultCache({ dir: tmpDir });
    const req = {
      fixtureId: 'f1',
      system: 'You are helpful',
      messages: [{ role: 'user' as const, content: 'Hello' }],
      prompt: 'Hello',
      model: 'test-model',
    };

    const key1 = cache.computeKey('openai', req);
    const key2 = cache.computeKey('openai', req);
    const keyDiffProvider = cache.computeKey('freellmapi', req);

    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyDiffProvider);
  });

  it('stores and retrieves cached provider responses', async () => {
    const cache = new ResultCache({ dir: tmpDir, enabled: true });
    const key = 'test-key-123';
    const response = {
      text: 'Cached output response',
      latencyMs: 150,
      model: 'test-model',
    };

    expect(await cache.get(key)).toBeUndefined();
    await cache.set(key, response);

    const retrieved = await cache.get(key);
    expect(retrieved).toEqual(response);

    const cleared = await cache.clear();
    expect(cleared).toBe(1);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('bypasses disk when enabled is false', async () => {
    const cache = new ResultCache({ dir: tmpDir, enabled: false });
    const key = 'test-key-disabled';
    const response = { text: 'No cache' };

    await cache.set(key, response);
    expect(await cache.get(key)).toBeUndefined();
  });
});

describe('Phase 3: LLM Judge Assertion', () => {
  const dummyFixture: PromptFixture = {
    id: 'case-judge-1',
    prompt: 'Explain photosynthesis simply.',
  };
  const dummySuite: TestSuite = {
    name: 'judge-suite',
    fixtures: [dummyFixture],
  };

  it('passes when judge assigns a score >= minScore', async () => {
    const assertion: LlmJudgeAssertion = {
      type: 'llm-judge',
      rubric: 'Must mention sunlight and plants.',
      minScore: 0.8,
    };

    const mockJudge = async () =>
      JSON.stringify({
        score: 0.95,
        reasoning: 'The response clearly explains sunlight and plants conversion to energy.',
      });

    const result = await validateLlmJudge(assertion, {
      output: 'Photosynthesis is how green plants turn sunlight into food energy.',
      fixture: dummyFixture,
      suite: dummySuite,
      variables: {},
      validators: new Map(),
      judge: mockJudge,
      logger: silentLogger,
    });

    expect(result.status).toBe('passed');
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0.95);
    expect(result.message).toContain('0.95 / 0.80');
    expect(result.message).toContain('clearly explains sunlight');
  });

  it('fails when judge assigns a score < minScore', async () => {
    const assertion: LlmJudgeAssertion = {
      type: 'llm-judge',
      rubric: 'Must be polite and helpful.',
      minScore: 0.7,
    };

    const mockJudge = async () =>
      '```json\n{"score": 0.3, "reasoning": "The response is overly brief and rude."}\n```';

    const result = await validateLlmJudge(assertion, {
      output: 'Go away.',
      fixture: dummyFixture,
      suite: dummySuite,
      variables: {},
      validators: new Map(),
      judge: mockJudge,
      logger: silentLogger,
    });

    expect(result.status).toBe('failed');
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.3);
    expect(result.message).toContain('overly brief and rude');
  });

  it('reports failed status if no judge is available', async () => {
    const assertion: LlmJudgeAssertion = {
      type: 'llm-judge',
      rubric: 'Must explain quantum physics.',
    };

    const result = await validateLlmJudge(assertion, {
      output: 'Quantum physics is hard.',
      fixture: dummyFixture,
      suite: dummySuite,
      variables: {},
      validators: new Map(),
      logger: silentLogger,
    });

    expect(result.status).toBe('failed');
    expect(result.passed).toBe(false);
    expect(result.message).toContain('No judge provider is configured');
  });
});

describe('Phase 3: Dataset Loaders (CSV & JSONL)', () => {
  it('parses CSV with quoted strings and commas', () => {
    const csvData = `id,name,role,description
1,"Alice, Chief Engineer","Tech Lead","Builds reliable, resilient systems"
2,Bob,Analyst,"Reviews financial data"`;

    const records = parseCsv(csvData);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      id: '1',
      name: 'Alice, Chief Engineer',
      role: 'Tech Lead',
      description: 'Builds reliable, resilient systems',
    });
    expect(records[1]).toEqual({
      id: '2',
      name: 'Bob',
      role: 'Analyst',
      description: 'Reviews financial data',
    });
  });

  it('parses JSONL lines into records', () => {
    const jsonlData = `{"id": "q1", "prompt": "What is 2+2?", "expected": "4"}
{"id": "q2", "prompt": "What is the capital of France?", "expected": "Paris"}`;

    const records = parseJsonl(jsonlData);
    expect(records).toHaveLength(2);
    expect(records[0]?.id).toBe('q1');
    expect(records[1]?.expected).toBe('Paris');
  });

  it('expands dataset rows using fixture template', () => {
    const rows = [
      { id: 'math-1', a: 10, b: 20, prompt: 'Add 10 and 20' },
      { id: 'math-2', a: 5, b: 15, prompt: 'Add 5 and 15' },
    ];

    const fixtures = expandDatasetRows(rows, {
      system: 'You are a calculator.',
      tags: ['math', 'dataset'],
      model: 'fast-model',
    });

    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]?.id).toBe('math-1');
    expect(fixtures[0]?.system).toBe('You are a calculator.');
    expect(fixtures[0]?.tags).toEqual(['math', 'dataset']);
    expect(fixtures[0]?.variables).toMatchObject({ a: 10, b: 20 });
    expect(fixtures[1]?.prompt).toBe('Add 5 and 15');
  });

  it('loads test suite referencing a CSV dataset file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-dataset-test-'));
    try {
      const csvContent = `id,question,topic
test-1,"What is photosynthesis?","biology"
test-2,"Explain gravity.","physics"`;
      await fs.writeFile(path.join(tmpDir, 'data.csv'), csvContent, 'utf8');

      const suiteContent = {
        name: 'dataset-suite',
        dataset: 'data.csv',
        fixtureTemplate: {
          prompt: '{{question}}',
          system: 'You are a science tutor.',
          tags: ['dataset-test'],
        },
        fixtures: [],
      };
      await fs.writeFile(
        path.join(tmpDir, 'test.suite.json'),
        JSON.stringify(suiteContent, null, 2),
        'utf8',
      );

      const loaded = await loadSuites(['test.suite.json'], tmpDir);
      expect(loaded).toHaveLength(1);
      const suite = loaded[0]!.suite;
      expect(suite.fixtures).toHaveLength(2);
      expect(suite.fixtures[0]?.id).toBe('test-1');
      expect(suite.fixtures[0]?.system).toBe('You are a science tutor.');
      expect(suite.fixtures[0]?.variables).toMatchObject({
        question: 'What is photosynthesis?',
        topic: 'biology',
      });
      expect(suite.fixtures[1]?.id).toBe('test-2');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Phase 3: Cross-Model Matrix Scorecard', () => {
  it('renders a formatted scorecard table with pass rates and latency', () => {
    const styler = createStylerFromOption('never');
    const table = renderMatrixScorecard(
      [
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          total: 10,
          passed: 10,
          failed: 0,
          passRate: 1.0,
          avgLatencyMs: 350,
        },
        {
          provider: 'freellmapi',
          model: 'gemini-2.5-flash',
          total: 10,
          passed: 9,
          failed: 1,
          passRate: 0.9,
          avgLatencyMs: 220,
        },
      ],
      styler,
    );

    expect(table).toContain('Cross-Model Matrix Scorecard');
    expect(table).toContain('Provider');
    expect(table).toContain('Model');
    expect(table).toContain('Pass Rate');
    expect(table).toContain('Avg Latency');
    expect(table).toContain('openai');
    expect(table).toContain('gpt-4o-mini');
    expect(table).toContain('100.0%');
    expect(table).toContain('350ms');
    expect(table).toContain('freellmapi');
    expect(table).toContain('gemini-2.5-flash');
    expect(table).toContain('90.0%');
    expect(table).toContain('220ms');
  });
});
