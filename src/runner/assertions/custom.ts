import type { CustomAssertion } from '../../core/types.js';
import type { AssertionResult } from '../../core/types.js';
import type { AssertionContext, AssertionValidator } from './types.js';

export const customValidator: AssertionValidator = async (
  assertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const custom = assertion as CustomAssertion;
  const name = custom.name ?? `custom:${custom.validator}`;

  const validator = context.validators.get(custom.validator);
  if (!validator) {
    const available = [...context.validators.keys()];
    return {
      name,
      type: 'custom',
      status: 'errored',
      passed: false,
      message:
        `no custom validator registered under "${custom.validator}"` +
        (available.length ? ` (registered: ${available.join(', ')})` : ' (none registered)'),
      durationMs: 0,
    };
  }

  try {
    const result = await validator(custom, context);
    return {
      ...result,
      name: result.name ?? name,
      type: 'custom',
    };
  } catch (error) {
    return {
      name,
      type: 'custom',
      status: 'errored',
      passed: false,
      message: `custom validator "${custom.validator}" threw: ${(error as Error).message}`,
      durationMs: 0,
    };
  }
};
