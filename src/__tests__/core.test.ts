import { describe, expect, it } from 'vitest';
import {
  defaultConfig,
  findConfigFile,
  loadConfig,
  resolveProvider,
  saveConfig,
  validateConfig,
} from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { parseArgs, flagBoolean, flagList, flagNumber, flagString } from '../cli/args.js';
import { renderTemplate } from '../runner/template.js';
import { applyDefaults, normalizePrompt, validateSuite } from '../runner/suiteLoader.js';
import { expandGlob, listFiles, pathExists, writeJsonFile } from '../utils/fs.js';
import { hashObject, shortHash, stableStringify } from '../utils/hash.js';
import { estimateTokens, countWords, splitSentences, stem, tokenize } from '../utils/text.js';
import { padVisible, truncateVisible, visibleWidth } from '../utils/ansi.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('config', () => {
  it('produces a valid default configuration', () => {
    const config = defaultConfig();
    expect(() => validateConfig(config)).not.toThrow();
    expect(config.version).toBe(1);
    expect(config.providers.mock.kind).toBe('mock');
  });

  it('rejects invalid configurations with a readable message', () => {
    expect(() => validateConfig({ version: 2 })).toThrow(ConfigError);
    expect(() => validateConfig({ version: 1, unknown: true })).toThrow(/Invalid configuration/);
  });

  it('warns when the default provider is not defined', () => {
    const config = validateConfig({ version: 1, defaultProvider: 'missing' });
    expect(config.defaultProvider).toBe('missing');
  });

  it('resolves named providers and falls back to mock', () => {
    const config = defaultConfig();
    expect(resolveProvider(config, 'mock').provider.kind).toBe('mock');
    expect(() => resolveProvider(config, 'nope')).toThrow(ConfigError);
  });

  it('loads and validates a config file from disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-config-'));
    try {
      await writeJsonFile(path.join(dir, 'prompt-guard.config.json'), {
        version: 1,
        suites: ['suites/**/*.suite.json'],
        outputDir: 'runs',
        providers: { mock: { kind: 'mock' } },
        defaultProvider: 'mock',
      });
      const loaded = await loadConfig(dir);
      expect(loaded.config.version).toBe(1);
      expect(loaded.rootDir).toBe(dir);
      expect(loaded.config.outputDir).toContain('runs');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing explicit config file', async () => {
    await expect(loadConfig(process.cwd(), 'definitely-not-here.json')).rejects.toThrow(
      /not found/i,
    );
  });

  it('finds the config file by walking up the directory tree', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-find-'));
    try {
      await saveConfig(path.join(dir, 'prompt-guard.config.json'));
      const nested = path.join(dir, 'a', 'b');
      await writeJsonFile(path.join(nested, 'placeholder.json'), {});
      const found = await findConfigFile(nested);
      expect(found).toBe(path.join(dir, 'prompt-guard.config.json'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('argument parser', () => {
  it('parses a command and positionals', () => {
    const args = parseArgs(['compare', 'run-a', 'run-b']);
    expect(args.command).toBe('compare');
    expect(args.positionals).toEqual(['run-a', 'run-b']);
  });

  it('parses boolean flags', () => {
    const args = parseArgs(['run', '--bail']);
    expect(flagBoolean(args, 'bail')).toBe(true);
  });

  it('parses inline and separate flag values', () => {
    expect(flagString(parseArgs(['run', '--model=gpt-4o']), 'model')).toBe('gpt-4o');
    expect(flagString(parseArgs(['run', '--model', 'gpt-4o']), 'model')).toBe('gpt-4o');
  });

  it('parses negated flags', () => {
    const args = parseArgs(['compare', '--no-write']);
    expect(flagBoolean(args, 'write', true)).toBe(false);
  });

  it('collects repeated flags into a list', () => {
    const args = parseArgs(['run', '--tag', 'a', '--tag', 'b,c']);
    expect(flagList(args, 'tag')).toEqual(['a', 'b', 'c']);
  });

  it('supports short aliases', () => {
    const args = parseArgs(['run', '-m', 'gpt-4o', '-t', 'smoke']);
    expect(flagString(args, 'model')).toBe('gpt-4o');
    expect(flagList(args, 'tag')).toEqual(['smoke']);
  });

  it('parses numbers with a fallback', () => {
    expect(flagNumber(parseArgs(['run', '--concurrency', '8']), 'concurrency')).toBe(8);
    expect(flagNumber(parseArgs(['run']), 'concurrency', 4)).toBe(4);
  });

  it('treats everything after -- as positionals', () => {
    const args = parseArgs(['run', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });
});

describe('template rendering', () => {
  it('substitutes variables', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'Ada' });
    expect(result.text).toBe('Hello Ada!');
    expect(result.used).toEqual(['name']);
  });

  it('supports default values', () => {
    expect(renderTemplate('Hello {{name | friend}}!').text).toBe('Hello friend!');
  });

  it('reports missing variables and leaves them untouched', () => {
    const result = renderTemplate('Hello {{name}}!');
    expect(result.text).toBe('Hello {{name}}!');
    expect(result.missing).toEqual(['name']);
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{  name  }}', { name: 'x' }).text).toBe('x');
  });
});

describe('suite loader helpers', () => {
  it('validates a suite and rejects duplicate ids', () => {
    const valid = {
      name: 'demo',
      fixtures: [{ id: 'a', prompt: 'x' }],
    };
    expect(() => validateSuite(valid, 'test')).not.toThrow();
    expect(() =>
      validateSuite({ name: 'demo', fixtures: [{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }] }, 'test'),
    ).toThrow(/Duplicate fixture id/);
  });

  it('rejects unknown fixture keys', () => {
    expect(() => validateSuite({ name: 'd', fixtures: [{ id: 'a', prompt: 'x', nope: 1 }] }, 't')).toThrow(
      /Invalid suite file/,
    );
  });

  it('applies suite defaults', () => {
    const fixture = applyDefaults(
      { id: 'a', prompt: 'x' },
      { assertions: [{ type: 'contains', value: 'y' }], model: 'm', system: 's' },
    );
    expect(fixture.model).toBe('m');
    expect(fixture.system).toBe('s');
    expect(fixture.assertions).toHaveLength(1);
  });

  it('lets fixture-level assertions win over suite defaults', () => {
    const fixture = applyDefaults(
      { id: 'a', prompt: 'x', assertions: [{ type: 'length', min: 1 }] },
      { assertions: [{ type: 'contains', value: 'y' }] },
    );
    expect(fixture.assertions?.[0]?.type).toBe('length');
  });

  it('normalises string and message prompts', () => {
    const fromString = normalizePrompt('hello');
    expect(fromString.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(fromString.userPrompt).toBe('hello');

    const fromMessages = normalizePrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(fromMessages.userPrompt).toBe('hi');
    expect(fromMessages.messages).toHaveLength(2);
  });
});

describe('file utilities', () => {
  it('expands globs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-glob-'));
    try {
      await writeJsonFile(path.join(dir, 'suites', 'a.suite.json'), {});
      await writeJsonFile(path.join(dir, 'suites', 'nested', 'b.suite.json'), {});
      await writeJsonFile(path.join(dir, 'suites', 'c.txt'), {});
      const found = await expandGlob('suites/**/*.suite.json', dir);
      expect(found.length).toBe(2);
      expect(found.every((f) => f.endsWith('.suite.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists files recursively', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-list-'));
    try {
      await writeJsonFile(path.join(dir, 'x', 'y.json'), {});
      const files = await listFiles(dir);
      expect(files.length).toBe(1);
      expect(await pathExists(files[0] as string)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('hashing utilities', () => {
  it('hashes objects independent of key order', () => {
    expect(hashObject({ a: 1, b: 2 })).toBe(hashObject({ b: 2, a: 1 }));
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('produces short hashes', () => {
    expect(shortHash('hello')).toHaveLength(12);
  });
});

describe('text utilities', () => {
  it('stems common inflections', () => {
    expect(stem('refunds')).toBe('refund');
    expect(stem('running')).toBe('run');
    expect(stem('cities')).toBe('city');
  });

  it('tokenizes and removes stopwords', () => {
    expect(tokenize('The quick brown fox')).toContain('quick');
    expect(tokenize('The quick brown fox', { stopwords: true })).not.toContain('the');
  });

  it('counts words and sentences', () => {
    expect(countWords('one two three')).toBe(3);
    expect(splitSentences('One. Two! Three?').length).toBe(3);
  });

  it('estimates tokens', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });
});

describe('ansi utilities', () => {
  it('computes visible width ignoring escape codes', () => {
    expect(visibleWidth('\u001b[31mabc\u001b[0m')).toBe(3);
  });

  it('pads to the requested width', () => {
    expect(visibleWidth(padVisible('ab', 5))).toBe(5);
  });

  it('truncates with an ellipsis', () => {
    const result = truncateVisible('abcdefgh', 5);
    expect(visibleWidth(result)).toBeLessThanOrEqual(5);
    expect(result.endsWith('…')).toBe(true);
  });
});
