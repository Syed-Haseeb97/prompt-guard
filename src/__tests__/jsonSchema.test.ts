import { describe, expect, it } from 'vitest';
import { validateJsonSchema, resolveRef, formatSchemaErrors } from '../runner/assertions/jsonSchema.js';

describe('validateJsonSchema — primitives', () => {
  it('validates string types', () => {
    const errors = validateJsonSchema('hello', { type: 'string' });
    expect(errors).toHaveLength(0);
  });

  it('reports type mismatches', () => {
    const errors = validateJsonSchema(42, { type: 'string' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('type');
    expect(errors[0]?.message).toContain('expected type string');
  });

  it('supports union types', () => {
    expect(validateJsonSchema('a', { type: ['string', 'number'] })).toHaveLength(0);
    expect(validateJsonSchema(true, { type: ['string', 'number'] })).toHaveLength(1);
  });

  it('treats integers as numbers', () => {
    expect(validateJsonSchema(3, { type: 'number' })).toHaveLength(0);
    expect(validateJsonSchema(3.5, { type: 'integer' })).toHaveLength(1);
  });

  it('validates enum and const', () => {
    expect(validateJsonSchema('a', { enum: ['a', 'b'] })).toHaveLength(0);
    expect(validateJsonSchema('c', { enum: ['a', 'b'] })).toHaveLength(1);
    expect(validateJsonSchema(7, { const: 7 })).toHaveLength(0);
    expect(validateJsonSchema(8, { const: 7 })).toHaveLength(1);
  });

  it('supports OpenAPI nullable', () => {
    expect(validateJsonSchema(null, { type: 'string', nullable: true })).toHaveLength(0);
    expect(validateJsonSchema(null, { type: 'string' })).toHaveLength(1);
  });
});

describe('validateJsonSchema — strings', () => {
  it('enforces minLength / maxLength', () => {
    expect(validateJsonSchema('ab', { type: 'string', minLength: 3 })).toHaveLength(1);
    expect(validateJsonSchema('abcd', { type: 'string', maxLength: 3 })).toHaveLength(1);
    expect(validateJsonSchema('abc', { type: 'string', minLength: 3, maxLength: 3 })).toHaveLength(0);
  });

  it('enforces pattern', () => {
    const errors = validateJsonSchema('abc', { type: 'string', pattern: '^\\d+$' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('pattern');
  });

  it('enforces formats', () => {
    expect(validateJsonSchema('nope', { type: 'string', format: 'email' })).toHaveLength(1);
    expect(validateJsonSchema('a@b.co', { type: 'string', format: 'email' })).toHaveLength(0);
  });
});

describe('validateJsonSchema — numbers', () => {
  it('enforces bounds', () => {
    expect(validateJsonSchema(1, { type: 'number', minimum: 5 })).toHaveLength(1);
    expect(validateJsonSchema(9, { type: 'number', maximum: 5 })).toHaveLength(1);
    expect(validateJsonSchema(5, { type: 'number', exclusiveMinimum: 5 })).toHaveLength(1);
    expect(validateJsonSchema(5, { type: 'number', exclusiveMaximum: 5 })).toHaveLength(1);
  });

  it('enforces multipleOf', () => {
    expect(validateJsonSchema(7, { type: 'number', multipleOf: 2 })).toHaveLength(1);
    expect(validateJsonSchema(8, { type: 'number', multipleOf: 2 })).toHaveLength(0);
  });
});

describe('validateJsonSchema — objects', () => {
  it('enforces required properties', () => {
    const errors = validateJsonSchema({ a: 1 }, { type: 'object', required: ['b'] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('required');
    expect(errors[0]?.message).toContain('"b"');
  });

  it('validates nested properties and reports the path', () => {
    const errors = validateJsonSchema(
      { user: { name: 42 } },
      {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/user/name');
  });

  it('rejects additional properties when disabled', () => {
    const errors = validateJsonSchema(
      { a: 1, b: 2 },
      { type: 'object', properties: { a: {} }, additionalProperties: false },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('additionalProperties');
  });

  it('validates additional properties against a schema', () => {
    const errors = validateJsonSchema(
      { a: 1, b: 'x' },
      { type: 'object', properties: { a: {} }, additionalProperties: { type: 'number' } },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/b');
  });

  it('supports patternProperties', () => {
    const schema = {
      type: 'object',
      patternProperties: { '^x-': { type: 'number' } },
      additionalProperties: false,
    };
    expect(validateJsonSchema({ 'x-a': 1 }, schema)).toHaveLength(0);
    expect(validateJsonSchema({ 'x-a': 'no' }, schema)).toHaveLength(1);
  });

  it('supports propertyNames', () => {
    const schema = { type: 'object', propertyNames: { pattern: '^[a-z]+$' } };
    expect(validateJsonSchema({ ok: 1 }, schema)).toHaveLength(0);
    expect(validateJsonSchema({ 'Not OK': 1 }, schema)).toHaveLength(1);
  });

  it('enforces minProperties / maxProperties', () => {
    expect(validateJsonSchema({ a: 1 }, { type: 'object', minProperties: 2 })).toHaveLength(1);
    expect(validateJsonSchema({ a: 1, b: 2 }, { type: 'object', maxProperties: 1 })).toHaveLength(1);
  });
});

describe('validateJsonSchema — arrays', () => {
  it('validates items', () => {
    const errors = validateJsonSchema([1, 'two'], { type: 'array', items: { type: 'number' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/1');
  });

  it('enforces minItems / maxItems', () => {
    expect(validateJsonSchema([1], { type: 'array', minItems: 2 })).toHaveLength(1);
    expect(validateJsonSchema([1, 2], { type: 'array', maxItems: 1 })).toHaveLength(1);
  });

  it('enforces uniqueItems', () => {
    const errors = validateJsonSchema([1, 1], { type: 'array', uniqueItems: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('uniqueItems');
  });

  it('supports tuple validation with additionalItems', () => {
    const schema = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };
    expect(validateJsonSchema(['a', 1], schema)).toHaveLength(0);
    expect(validateJsonSchema(['a', 'b'], schema)).toHaveLength(1);
  });

  it('supports contains', () => {
    const schema = { type: 'array', contains: { type: 'number' } };
    expect(validateJsonSchema(['a', 1], schema)).toHaveLength(0);
    expect(validateJsonSchema(['a', 'b'], schema)).toHaveLength(1);
  });
});

describe('validateJsonSchema — combinators', () => {
  it('supports allOf', () => {
    const schema = { allOf: [{ type: 'object' }, { required: ['a'] }] };
    expect(validateJsonSchema({ a: 1 }, schema)).toHaveLength(0);
    expect(validateJsonSchema({}, schema)).toHaveLength(1);
  });

  it('supports anyOf', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateJsonSchema('x', schema)).toHaveLength(0);
    expect(validateJsonSchema(true, schema)).toHaveLength(1);
  });

  it('supports oneOf and rejects ambiguous matches', () => {
    const schema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
    expect(validateJsonSchema('x', schema)).toHaveLength(1);
    // 3 matches both `number` and `integer` -> ambiguous
    expect(validateJsonSchema(3, schema)).toHaveLength(1);
    expect(validateJsonSchema(3, schema)[0]?.keyword).toBe('oneOf');
  });

  it('supports not', () => {
    const schema = { not: { type: 'string' } };
    expect(validateJsonSchema(1, schema)).toHaveLength(0);
    expect(validateJsonSchema('a', schema)).toHaveLength(1);
  });

  it('supports if/then/else', () => {
    const schema = {
      if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
      then: { required: ['extra'] },
      else: { required: ['other'] },
    };
    expect(validateJsonSchema({ kind: 'a' }, schema)).toHaveLength(1);
    expect(validateJsonSchema({ kind: 'a', extra: 1 }, schema)).toHaveLength(0);
    expect(validateJsonSchema({ kind: 'b' }, schema)).toHaveLength(1);
  });
});

describe('validateJsonSchema — $ref', () => {
  const root = {
    $defs: {
      address: {
        type: 'object',
        required: ['city'],
        properties: { city: { type: 'string' } },
      },
    },
    type: 'object',
    properties: { home: { $ref: '#/$defs/address' } },
  };

  it('resolves local references', () => {
    expect(validateJsonSchema({ home: { city: 'Berlin' } }, root, { rootSchema: root })).toHaveLength(0);
    const errors = validateJsonSchema({ home: { city: 5 } }, root, { rootSchema: root });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('/home/city');
  });

  it('reports unresolvable references', () => {
    const errors = validateJsonSchema({}, { $ref: '#/$defs/missing' }, { rootSchema: { $defs: {} } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('$ref');
  });

  it('resolveRef walks JSON pointers', () => {
    const resolved = resolveRef('#/$defs/address', root as Record<string, unknown>);
    expect(resolved).toBeDefined();
  });
});

describe('formatSchemaErrors', () => {
  it('renders a readable summary', () => {
    const errors = validateJsonSchema({ a: 1 }, { type: 'object', required: ['b'] });
    const text = formatSchemaErrors(errors);
    expect(text).toContain('missing required property');
    expect(formatSchemaErrors([])).toBe('no errors');
  });
});
