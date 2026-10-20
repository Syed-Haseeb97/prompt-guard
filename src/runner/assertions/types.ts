import type {
  Assertion,
  AssertionResult,
  PromptFixture,
  TestSuite,
} from '../../core/types.js';
import type { Logger } from '../../core/logger.js';

/** A user-supplied embedding function (e.g. an API call to an embedding model). */
export type EmbeddingFunction = (text: string) => Promise<number[]>;

/** A user-registered custom validator. */
export type CustomValidator = (
  assertion: Extract<Assertion, { type: 'custom' }>,
  context: AssertionContext,
) => Promise<AssertionResult> | AssertionResult;

export interface AssertionContext {
  /** Raw model output under test. */
  output: string;
  /** The fixture that produced the output. */
  fixture: PromptFixture;
  /** The suite containing the fixture. */
  suite: TestSuite;
  /** Variables interpolated into the prompt. */
  variables: Record<string, string | number | boolean>;
  /** Custom validators available to `type: 'custom'` assertions. */
  validators: Map<string, CustomValidator>;
  /** Optional embedding provider for semantic assertions. */
  embed?: EmbeddingFunction;
  /** Logger for diagnostics. */
  logger: Logger;
}

export type AssertionValidator = (
  assertion: Assertion,
  context: AssertionContext,
) => Promise<AssertionResult> | AssertionResult;

export interface AssertionOutcome {
  result: AssertionResult;
}
