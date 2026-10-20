import type { JsonSchemaAssertion } from '../../core/types.js';
import type { AssertionResult } from '../../core/types.js';
import { extractJson } from './jsonExtract.js';
import { formatSchemaErrors, validateJsonSchema } from './jsonSchema.js';
import type { AssertionContext, AssertionValidator } from './types.js';

export const jsonSchemaValidator: AssertionValidator = async (
  assertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const jsonSchema = assertion as JsonSchemaAssertion;
  const name = jsonSchema.name ?? 'json schema';
  const extractMode = jsonSchema.extract ?? 'auto';

  let parsed: unknown;
  let raw = '';
  try {
    const extracted = extractJson(context.output, extractMode);
    parsed = extracted.value;
    raw = extracted.raw;
  } catch (error) {
    return {
      name,
      type: 'jsonSchema',
      status: 'failed',
      passed: false,
      message: `could not extract JSON from the output: ${(error as Error).message}`,
      actual: context.output,
      details: { extractMode },
      durationMs: 0,
    };
  }

  const errors = validateJsonSchema(parsed, jsonSchema.schema, {
    rootSchema: jsonSchema.schema,
  });

  const passed = errors.length === 0;

  return {
    name,
    type: 'jsonSchema',
    status: passed ? 'passed' : 'failed',
    passed,
    message: passed
      ? 'output matches the JSON schema'
      : `JSON schema validation failed: ${formatSchemaErrors(errors)}`,
    expected: jsonSchema.schema,
    actual: parsed,
    details: {
      errors,
      errorCount: errors.length,
      extractMode,
      raw,
    },
    durationMs: 0,
  };
};
