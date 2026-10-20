import type { ContainsAssertion, LengthAssertion } from '../../core/types.js';
import type { AssertionResult } from '../../core/types.js';
import { countWords, estimateTokens, splitSentences } from '../../utils/text.js';
import type { AssertionContext, AssertionValidator } from './types.js';

export const containsValidator: AssertionValidator = async (
  assertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const contains = assertion as ContainsAssertion;
  const name = contains.name ?? 'contains';
  const ignoreCase = contains.ignoreCase ?? true;
  const negate = contains.negate ?? false;

  const haystack = ignoreCase ? context.output.toLowerCase() : context.output;
  const needle = ignoreCase ? contains.value.toLowerCase() : contains.value;
  const found = haystack.includes(needle);
  const passed = negate ? !found : found;

  return {
    name,
    type: 'contains',
    status: passed ? 'passed' : 'failed',
    passed,
    message: passed
      ? `${negate ? 'string correctly absent' : 'string found'}`
      : `${negate ? 'string unexpectedly present' : 'string not found'}: ${JSON.stringify(contains.value)}`,
    expected: contains.value,
    actual: context.output,
    details: { ignoreCase, negate, found },
    durationMs: 0,
  };
};

/** Measure the length of a text in the requested unit. */
export function measureLength(
  text: string,
  unit: NonNullable<LengthAssertion['unit']>,
  tokenRatio = 4,
): number {
  switch (unit) {
    case 'words':
      return countWords(text);
    case 'sentences':
      return splitSentences(text).length;
    case 'lines':
      return text.split('\n').length;
    case 'tokens':
      return estimateTokens(text, tokenRatio);
    case 'chars':
    default:
      return text.length;
  }
}

export const lengthValidator: AssertionValidator = async (
  assertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const length = assertion as LengthAssertion;
  const name = length.name ?? 'length';
  const unit = length.unit ?? 'chars';
  const measured = measureLength(context.output, unit, length.tokenRatio);

  const min = length.min;
  const max = length.max;
  const problems: string[] = [];
  if (min !== undefined && measured < min) {
    problems.push(`length ${measured} is below the minimum of ${min}`);
  }
  if (max !== undefined && measured > max) {
    problems.push(`length ${measured} is above the maximum of ${max}`);
  }

  const passed = problems.length === 0;

  return {
    name,
    type: 'length',
    status: passed ? 'passed' : 'failed',
    passed,
    message: passed
      ? `length ${measured} ${unit} is within the allowed range`
      : problems.join('; '),
    expected: { min, max, unit },
    actual: measured,
    details: { measured, unit },
    durationMs: 0,
  };
};
