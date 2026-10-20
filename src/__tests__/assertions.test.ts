import { describe, expect, it } from 'vitest';
import { compilePattern, regexValidator } from '../runner/assertions/regex.js';
import { findKeyword, keywordsValidator } from '../runner/assertions/keywords.js';
import { containsValidator, lengthValidator, measureLength } from '../runner/assertions/misc.js';
import { runAssertions } from '../runner/assertions/index.js';
import { silentLogger } from '../core/logger.js';
import type { AssertionContext } from '../runner/assertions/types.js';
import type { TestSuite } from '../core/types.js';

const suite: TestSuite = { name: 'test', fixtures: [] };

function makeContext(output: string): AssertionContext {
  return {
    output,
    fixture: { id: 'f', prompt: 'p' },
    suite,
    variables: {},
    validators: new Map(),
    logger: silentLogger,
  };
}

describe('regex assertion', () => {
  it('passes when any pattern matches', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: ['\\d{3}-\\d{4}', 'refund'] },
      makeContext('Your order 482-1234 qualifies for a refund.'),
    );
    expect(result.passed).toBe(true);
    expect(result.status).toBe('passed');
  });

  it('fails when no pattern matches', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: '\\d{3}-\\d{4}' },
      makeContext('no phone number here'),
    );
    expect(result.passed).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('supports the "all" mode', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: ['refund', 'order'], match: 'all' },
      makeContext('refund for order 1'),
    );
    expect(result.passed).toBe(true);

    const failing = await regexValidator(
      { type: 'regex', pattern: ['refund', 'invoice'], match: 'all' },
      makeContext('refund only'),
    );
    expect(failing.passed).toBe(false);
  });

  it('supports the "none" mode for prohibited patterns', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: 'guarantee', match: 'none' },
      makeContext('we cannot guarantee delivery'),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain('guarantee');
  });

  it('is case-insensitive by default in the "none" mode', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: 'guarantee', match: 'none' },
      makeContext('We GUARANTEE delivery'),
    );
    expect(result.passed).toBe(false);
  });

  it('honours explicit flags', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: 'refund', flags: '' },
      makeContext('REFUND requested'),
    );
    expect(result.passed).toBe(false);
  });

  it('reports invalid patterns as errors', async () => {
    const result = await regexValidator(
      { type: 'regex', pattern: '([unclosed' },
      makeContext('text'),
    );
    expect(result.status).toBe('errored');
  });

  it('translates PCRE-style inline flags', () => {
    const re = compilePattern('(?i)hello', '');
    expect(re.test('HELLO')).toBe(true);
  });
});

describe('keywords assertion', () => {
  it('requires every required keyword', async () => {
    const result = await keywordsValidator(
      { type: 'keywords', required: ['refund', 'order'] },
      makeContext('Your refund for the order is approved.'),
    );
    expect(result.passed).toBe(true);
  });

  it('fails when a required keyword is missing', async () => {
    const result = await keywordsValidator(
      { type: 'keywords', required: ['refund', 'escalate'] },
      makeContext('Your refund is approved.'),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain('escalate');
  });

  it('enforces anyOf alternatives', async () => {
    const passing = await keywordsValidator(
      { type: 'keywords', anyOf: ['email', 'phone'] },
      makeContext('We will email you shortly.'),
    );
    expect(passing.passed).toBe(true);

    const failing = await keywordsValidator(
      { type: 'keywords', anyOf: ['email', 'phone'] },
      makeContext('We will contact you shortly.'),
    );
    expect(failing.passed).toBe(false);
  });

  it('rejects prohibited keywords', async () => {
    const result = await keywordsValidator(
      { type: 'keywords', prohibited: ['guarantee', 'refund'] },
      makeContext('We guarantee a full refund.'),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain('guarantee');
    expect(result.message).toContain('refund');
  });

  it('honours minRequired', async () => {
    const result = await keywordsValidator(
      { type: 'keywords', required: ['a', 'b', 'c'], minRequired: 2 },
      makeContext('a and b only'),
    );
    expect(result.passed).toBe(true);
  });

  it('supports case sensitivity', async () => {
    const insensitive = await keywordsValidator(
      { type: 'keywords', required: ['Refund'] },
      makeContext('refund issued'),
    );
    expect(insensitive.passed).toBe(true);

    const sensitive = await keywordsValidator(
      { type: 'keywords', required: ['Refund'], caseSensitive: true },
      makeContext('refund issued'),
    );
    expect(sensitive.passed).toBe(false);
  });

  it('supports whole-word matching', async () => {
    expect(findKeyword('concatenate', 'cat', { wholeWord: true }).found).toBe(false);
    expect(findKeyword('a cat sat', 'cat', { wholeWord: true }).found).toBe(true);
    expect(findKeyword('concatenate', 'cat').found).toBe(true);
  });
});

describe('contains assertion', () => {
  it('passes when the value is present', async () => {
    const result = await containsValidator(
      { type: 'contains', value: 'refund' },
      makeContext('Refund granted'),
    );
    expect(result.passed).toBe(true);
  });

  it('fails when the value is absent', async () => {
    const result = await containsValidator(
      { type: 'contains', value: 'refund' },
      makeContext('nothing here'),
    );
    expect(result.passed).toBe(false);
  });

  it('supports negation', async () => {
    const result = await containsValidator(
      { type: 'contains', value: 'refund', negate: true },
      makeContext('nothing here'),
    );
    expect(result.passed).toBe(true);
  });
});

describe('length assertion', () => {
  it('enforces min and max', async () => {
    const result = await lengthValidator(
      { type: 'length', min: 5, max: 10, unit: 'chars' },
      makeContext('abc'),
    );
    expect(result.passed).toBe(false);
    expect(result.actual).toBe(3);
  });

  it('measures words and sentences', async () => {
    expect(measureLength('one two three', 'words')).toBe(3);
    expect(measureLength('One. Two. Three.', 'sentences')).toBe(3);
    expect(measureLength('a\nb\nc', 'lines')).toBe(3);
  });
});

describe('runAssertions', () => {
  it('marks disabled assertions as skipped', async () => {
    const results = await runAssertions(
      [{ type: 'contains', value: 'x', enabled: false }],
      makeContext('x'),
    );
    expect(results[0]?.status).toBe('skipped');
    expect(results[0]?.passed).toBe(true);
  });

  it('downgrades severity warn failures to warnings', async () => {
    const results = await runAssertions(
      [{ type: 'contains', value: 'missing', severity: 'warn' }],
      makeContext('output'),
    );
    expect(results[0]?.status).toBe('warned');
    expect(results[0]?.passed).toBe(true);
  });

  it('reports unknown assertion types as errors', async () => {
    const results = await runAssertions(
      [{ type: 'nope' } as never],
      makeContext('output'),
    );
    expect(results[0]?.status).toBe('errored');
  });

  it('records a duration for every assertion', async () => {
    const results = await runAssertions(
      [{ type: 'contains', value: 'output' }],
      makeContext('output'),
    );
    expect(typeof results[0]?.durationMs).toBe('number');
  });
});
