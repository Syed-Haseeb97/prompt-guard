import { describe, expect, it } from 'vitest';
import {
  extractFencedJson,
  extractJson,
  findBalancedJson,
  tryParseJson,
} from '../runner/assertions/jsonExtract.js';
import { jsonSchemaValidator } from '../runner/assertions/jsonSchemaAssertion.js';
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

describe('extractJson', () => {
  it('parses strict JSON', () => {
    const result = extractJson('{"a":1}');
    expect(result.value).toEqual({ a: 1 });
    expect(result.mode).toBe('strict');
  });

  it('extracts JSON from a markdown fence', () => {
    const result = extractJson('Here you go:\n```json\n{"a":1}\n```\nThanks!');
    expect(result.value).toEqual({ a: 1 });
    expect(result.mode).toBe('markdown');
  });

  it('extracts JSON embedded in prose', () => {
    const result = extractJson('The result is {"a": 1} as requested.');
    expect(result.value).toEqual({ a: 1 });
    expect(result.mode).toBe('braces');
  });

  it('throws when no JSON is present', () => {
    expect(() => extractJson('no json at all')).toThrow(/could not extract/i);
  });

  it('supports the strict extraction mode', () => {
    expect(() => extractJson('prefix {"a":1}', 'strict')).toThrow(/not valid JSON/i);
  });

  it('supports the markdown extraction mode', () => {
    expect(() => extractJson('{"a":1}', 'markdown')).toThrow(/fenced/i);
  });

  it('supports first and last extraction modes', () => {
    const text = '{"a":1} and {"b":2}';
    expect(extractJson(text, 'first').value).toEqual({ a: 1 });
    expect(extractJson(text, 'last').value).toEqual({ b: 2 });
  });

  it('ignores braces inside strings', () => {
    const text = 'the value is {"text": "a } brace"} ok';
    expect(extractJson(text).value).toEqual({ text: 'a } brace' });
  });
});

describe('json extraction helpers', () => {
  it('tryParseJson returns undefined on failure', () => {
    expect(tryParseJson('nope')).toBeUndefined();
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('extractFencedJson returns the last fenced block', () => {
    const text = '```json\n{"a":1}\n```\ntext\n```json\n{"b":2}\n```';
    expect(extractFencedJson(text)).toBe('{"b":2}');
  });

  it('findBalancedJson locates objects and arrays', () => {
    const found = findBalancedJson('x {"a":[1,2]} y [3,4]');
    expect(found).toHaveLength(2);
  });
});

describe('jsonSchema assertion', () => {
  const schema = {
    type: 'object',
    required: ['answer'],
    properties: {
      answer: { type: 'string' },
      score: { type: 'number', minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  };

  it('passes when the output matches the schema', async () => {
    const result = await jsonSchemaValidator(
      { type: 'jsonSchema', schema },
      makeContext('{"answer":"yes","score":0.9}'),
    );
    expect(result.passed).toBe(true);
    expect(result.status).toBe('passed');
  });

  it('fails when a required property is missing', async () => {
    const result = await jsonSchemaValidator(
      { type: 'jsonSchema', schema },
      makeContext('{"score":0.5}'),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toContain('answer');
  });

  it('fails when the output is not JSON at all', async () => {
    const result = await jsonSchemaValidator(
      { type: 'jsonSchema', schema },
      makeContext('I cannot answer that.'),
    );
    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/could not extract JSON/i);
  });

  it('reports the individual schema errors in the details', async () => {
    const result = await jsonSchemaValidator(
      { type: 'jsonSchema', schema },
      makeContext('{"answer":5}'),
    );
    expect(result.passed).toBe(false);
    const details = result.details as { errorCount: number };
    expect(details.errorCount).toBeGreaterThan(0);
  });

  it('extracts JSON from a markdown fence', async () => {
    const result = await jsonSchemaValidator(
      { type: 'jsonSchema', schema, extract: 'auto' },
      makeContext('```json\n{"answer":"ok"}\n```'),
    );
    expect(result.passed).toBe(true);
  });
});
