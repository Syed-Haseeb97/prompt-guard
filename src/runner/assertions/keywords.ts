import type { KeywordsAssertion } from '../../core/types.js';
import type { AssertionResult } from '../../core/types.js';
import type { AssertionContext, AssertionValidator } from './types.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a keyword in a text.
 *
 * When `wholeWord` is enabled the keyword is matched on word boundaries so
 * "cat" does not match "concatenate".
 */
export function findKeyword(
  text: string,
  keyword: string,
  options: { caseSensitive?: boolean; wholeWord?: boolean } = {},
): { found: boolean; index: number } {
  const { caseSensitive = false, wholeWord = false } = options;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();

  if (needle === '') return { found: true, index: 0 };

  if (wholeWord) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`, caseSensitive ? 'u' : 'iu');
    const match = re.exec(haystack);
    return { found: match !== null, index: match?.index ?? -1 };
  }

  const index = haystack.indexOf(needle);
  return { found: index >= 0, index };
}

export const keywordsValidator: AssertionValidator = async (
  assertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const keywords = assertion as KeywordsAssertion;
  const name = keywords.name ?? 'keywords';
  const options = {
    caseSensitive: keywords.caseSensitive ?? false,
    wholeWord: keywords.wholeWord ?? false,
  };

  const required = keywords.required ?? [];
  const anyOf = keywords.anyOf ?? [];
  const prohibited = [...(keywords.prohibited ?? []), ...(keywords.none ?? [])];
  const minRequired = keywords.minRequired;

  const presentRequired = required.filter(
    (keyword) => findKeyword(context.output, keyword, options).found,
  );
  const missingRequired = required.filter(
    (keyword) => !findKeyword(context.output, keyword, options).found,
  );
  const presentAny = anyOf.filter(
    (keyword) => findKeyword(context.output, keyword, options).found,
  );
  const presentProhibited = prohibited.filter(
    (keyword) => findKeyword(context.output, keyword, options).found,
  );

  const problems: string[] = [];

  if (minRequired !== undefined) {
    if (presentRequired.length < minRequired) {
      problems.push(
        `only ${presentRequired.length}/${required.length} required keyword(s) present, need at least ${minRequired}`,
      );
    }
  } else if (missingRequired.length > 0) {
    problems.push(`missing required keyword(s): ${missingRequired.join(', ')}`);
  }

  if (anyOf.length > 0 && presentAny.length === 0) {
    problems.push(`none of the required alternatives present: ${anyOf.join(', ')}`);
  }

  if (presentProhibited.length > 0) {
    problems.push(`prohibited keyword(s) present: ${presentProhibited.join(', ')}`);
  }

  const passed = problems.length === 0;
  const details = {
    required: { present: presentRequired, missing: missingRequired },
    anyOf: { present: presentAny, allowed: anyOf },
    prohibited: { present: presentProhibited },
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
  };

  return {
    name,
    type: 'keywords',
    status: passed ? 'passed' : 'failed',
    passed,
    message: passed
      ? 'all keyword constraints satisfied'
      : problems.join('; '),
    expected: { required, anyOf, prohibited },
    actual: context.output,
    details,
    durationMs: 0,
  };
};
