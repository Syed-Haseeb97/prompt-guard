import type { Assertion, AssertionResult, AssertionSeverity } from '../../core/types.js';
import { customValidator } from './custom.js';
import { jsonSchemaValidator } from './jsonSchemaAssertion.js';
import { keywordsValidator } from './keywords.js';
import { containsValidator, lengthValidator } from './misc.js';
import { regexValidator } from './regex.js';
import { semanticValidator } from './semantic.js';
import type { AssertionContext, AssertionValidator } from './types.js';

export * from './types.js';
export * from './semantic.js';
export * from './regex.js';
export * from './keywords.js';
export * from './jsonSchema.js';
export * from './jsonExtract.js';

/** Registry of the built-in assertion validators, keyed by assertion type. */
export const BUILT_IN_VALIDATORS: Record<Assertion['type'], AssertionValidator> = {
  semantic: semanticValidator,
  regex: regexValidator,
  jsonSchema: jsonSchemaValidator,
  keywords: keywordsValidator,
  contains: containsValidator,
  length: lengthValidator,
  custom: customValidator,
};

/** The assertion types understood by prompt-guard. */
export const ASSERTION_TYPES = Object.keys(BUILT_IN_VALIDATORS) as Array<Assertion['type']>;

/**
 * Run a list of assertions against a single output.
 *
 * - Assertions with `enabled: false` are reported as `skipped`.
 * - Assertions with `severity: 'warn'` never fail a case; they are reported
 *   with the `warned` status.
 * - A validator that throws is reported as `errored`.
 */
export async function runAssertions(
  assertions: Assertion[],
  context: AssertionContext,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    const label = assertion.name ?? assertion.type;

    if (assertion.enabled === false) {
      results.push({
        name: label,
        type: assertion.type,
        status: 'skipped',
        passed: true,
        message: 'assertion disabled',
        durationMs: 0,
      });
      continue;
    }

    const validator = BUILT_IN_VALIDATORS[assertion.type];
    if (!validator) {
      results.push({
        name: label,
        type: assertion.type,
        status: 'errored',
        passed: false,
        message: `unknown assertion type "${assertion.type}"`,
        durationMs: 0,
      });
      continue;
    }

    const startedAt = performance.now();
    try {
      const result = await validator(assertion, context);
      const durationMs = performance.now() - startedAt;
      const severity: AssertionSeverity = assertion.severity ?? 'error';
      const finalised: AssertionResult = {
        ...result,
        name: result.name ?? label,
        durationMs: Number.isFinite(durationMs) ? Number(durationMs.toFixed(3)) : 0,
      };

      if (severity === 'warn' && finalised.status === 'failed') {
        finalised.status = 'warned';
        finalised.passed = true;
        finalised.message = `[warn] ${finalised.message}`;
      } else if (severity === 'warn' && finalised.status === 'errored') {
        finalised.status = 'warned';
        finalised.passed = true;
        finalised.message = `[warn] ${finalised.message}`;
      }

      results.push(finalised);
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      results.push({
        name: label,
        type: assertion.type,
        status: 'errored',
        passed: false,
        message: `assertion threw: ${(error as Error).message}`,
        durationMs: Number.isFinite(durationMs) ? Number(durationMs.toFixed(3)) : 0,
      });
    }
  }

  return results;
}

/** Determine whether a set of assertion results should fail the case. */
export function isFailure(results: AssertionResult[]): boolean {
  return results.some((r) => r.status === 'failed' || r.status === 'errored');
}
