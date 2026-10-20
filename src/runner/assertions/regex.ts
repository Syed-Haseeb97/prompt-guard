import type { RegexAssertion } from '../../core/types.js';
import type { AssertionResult } from '../../core/types.js';
import type { AssertionContext, AssertionValidator } from './types.js';

/** Compile a pattern, translating common PCRE-ish syntax to JS. */
export function compilePattern(pattern: string, flags: string): RegExp {
  let jsPattern = pattern;
  // JS does not support the `(?i)` inline flag group — approximate it.
  if (/^\(\?i\)/.test(jsPattern)) {
    jsPattern = jsPattern.replace(/^\(\?i\)/, '');
    if (!flags.includes('i')) flags += 'i';
  }
  // Python style `(?P<name>...)` -> `(?<name>...)`.
  jsPattern = jsPattern.replace(/\(\?P</g, '(?<');
  try {
    return new RegExp(jsPattern, flags);
  } catch {
    // Retry without the unicode flag which rejects some valid escapes.
    const fallbackFlags = flags.replace('u', '');
    return new RegExp(jsPattern, fallbackFlags);
  }
}

export const regexValidator: AssertionValidator = async (
  assertion,
  context: AssertionContext,
): Promise<AssertionResult> => {
  const regex = assertion as RegexAssertion;
  const name = regex.name ?? 'regex';
  const patterns = Array.isArray(regex.pattern) ? regex.pattern : [regex.pattern];
  const mode = regex.match ?? 'any';
  const flags = regex.flags ?? (mode === 'none' ? 'i' : '');

  if (patterns.length === 0) {
    return {
      name,
      type: 'regex',
      status: 'errored',
      passed: false,
      message: 'regex assertion requires at least one pattern',
      durationMs: 0,
    };
  }

  const results = patterns.map((pattern) => {
    let re: RegExp;
    try {
      re = compilePattern(pattern, flags);
    } catch (error) {
      return { pattern, error: (error as Error).message, matched: false };
    }
    re.lastIndex = 0;
    const matched = re.test(context.output);
    return { pattern, matched };
  });

  const failures = results.filter((r) => r.error);
  if (failures.length > 0) {
    return {
      name,
      type: 'regex',
      status: 'errored',
      passed: false,
      message: `invalid regular expression: ${failures[0]?.error}`,
      expected: patterns,
      details: { failures },
      durationMs: 0,
    };
  }

  const matchedCount = results.filter((r) => r.matched).length;
  let passed: boolean;
  let message: string;

  switch (mode) {
    case 'all':
      passed = matchedCount === patterns.length;
      message = passed
        ? `all ${patterns.length} pattern(s) matched`
        : `${matchedCount}/${patterns.length} pattern(s) matched; expected all`;
      break;
    case 'none':
      passed = matchedCount === 0;
      message = passed
        ? 'no prohibited pattern matched'
        : `${matchedCount} prohibited pattern(s) matched: ${results
            .filter((r) => r.matched)
            .map((r) => r.pattern)
            .join(', ')}`;
      break;
    case 'any':
    default:
      passed = matchedCount > 0;
      message = passed
        ? `matched ${matchedCount}/${patterns.length} pattern(s)`
        : `none of the ${patterns.length} pattern(s) matched`;
      break;
  }

  return {
    name,
    type: 'regex',
    status: passed ? 'passed' : 'failed',
    passed,
    message,
    expected: patterns,
    actual: context.output,
    details: {
      mode,
      flags,
      matches: results.map((r) => ({ pattern: r.pattern, matched: r.matched })),
    },
    durationMs: 0,
  };
};
