/**
 * prompt-guard — shared type definitions.
 *
 * Every public surface (config, suite files, run reports, comparison reports)
 * is described here so that the CLI, the engine and the assertion engines all
 * agree on a single contract.
 */

export const RUN_REPORT_SCHEMA_VERSION = '1.0' as const;
export const COMPARISON_REPORT_SCHEMA_VERSION = '1.0' as const;

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

export type ProviderKind =
  | 'mock'
  | 'openai'
  | 'anthropic'
  | 'http'
  | 'echo';

export interface MockRule {
  /** Match against the rendered user prompt. */
  match?: string;
  /** Fixture id this rule applies to (exact). */
  fixtureId?: string;
  /** Response body returned when the rule matches. */
  response: string;
  /** Optional JSON to be returned as the payload. */
  json?: unknown;
  /** Case-insensitive matching for `match`. */
  caseInsensitive?: boolean;
}

export interface MockProviderConfig {
  /**
   * Deterministic echo mode. `hash` derives a stable pseudo-response from the
   * prompt so the same fixture always yields the same output.
   */
  mode?: 'hash' | 'echo' | 'rules';
  rules?: MockRule[];
  /** Default response used when no rule matches. */
  defaultResponse?: string;
  /** Seed mixed into hash-mode responses. */
  seed?: string;
  /** Simulated latency in ms. */
  latencyMs?: number;
  /** Simulate provider errors for these fixture ids. */
  errors?: Array<{ fixtureId: string; message: string; status?: number }>;
}

export interface ProviderConfig {
  kind: ProviderKind;
  /** Model identifier passed through to the provider. */
  model?: string;
  /** Base URL for HTTP-based providers. */
  baseUrl?: string;
  /** Name of the env var holding the API key. */
  apiKeyEnv?: string;
  /** Inline API key (discouraged; prefer `apiKeyEnv`). */
  apiKey?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
  /** System prompt injected by the provider when the fixture has none. */
  systemPrompt?: string;
  /** Mock-specific behaviour. */
  mock?: MockProviderConfig;
  /**
   * For `http` providers: which body field holds the generated text.
   * Supports dot paths, e.g. `choices.0.message.content`.
   */
  responsePath?: string;
  /** For `http` providers: the JSON request body template. */
  requestTemplate?: Record<string, unknown>;
  /** Per-provider overrides for retries. */
  retries?: number;
}

export interface ProviderRequest {
  fixtureId: string;
  system?: string;
  messages: PromptMessage[];
  /** Fully rendered user prompt (concatenation of user turns). */
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  /** Static response override for mock providers. */
  mockResponse?: string;
}

export interface ProviderResponse {
  /** Generated text. */
  text: string;
  /** Raw provider payload, when available. */
  raw?: unknown;
  /** Provider-reported model identifier. */
  model?: string;
  /** Token usage, when the provider reports it. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Round-trip duration in ms. */
  latencyMs: number;
  /** Provider specific metadata (request id, finish reason, ...). */
  metadata?: Record<string, unknown>;
}

export interface Provider {
  readonly kind: ProviderKind;
  readonly model?: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/* -------------------------------------------------------------------------- */
/* Prompts & fixtures                                                          */
/* -------------------------------------------------------------------------- */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface PromptMessage {
  role: MessageRole;
  content: string;
  name?: string;
}

export type AssertionType =
  | 'semantic'
  | 'regex'
  | 'jsonSchema'
  | 'keywords'
  | 'contains'
  | 'length'
  | 'custom';

export type AssertionSeverity = 'error' | 'warn';

export interface BaseAssertion {
  type: AssertionType;
  /** Human readable label; defaults to the assertion type. */
  name?: string;
  /** `error` failures fail the case, `warn` failures are reported but do not. */
  severity?: AssertionSeverity;
  /** Set to false to skip an inherited/default assertion. */
  enabled?: boolean;
}

/** Weights used by the blended semantic similarity metric. */
export interface SemanticWeights {
  wordJaccard: number;
  wordDice: number;
  charBigram: number;
  levenshtein: number;
  /** Weight of the embedding signal; only used when an embedder is configured. */
  embeddingWeight?: number;
}

export interface SemanticAssertion extends BaseAssertion {
  type: 'semantic';
  /** Reference text(s). The best-scoring candidate wins. */
  expected: string | string[];
  /** Minimum acceptable similarity in the inclusive range [0, 1]. */
  threshold?: number;
  /** Maximum acceptable similarity (used with `mode: 'notSimilar'`). */
  maxSimilarity?: number;
  /** `similar` (default) asserts a minimum score; `notSimilar` a maximum. */
  mode?: 'similar' | 'notSimilar';
  /** Override the blended metric weights. */
  weights?: Partial<SemanticWeights>;
  /** Case-insensitive comparison. Defaults to true. */
  ignoreCase?: boolean;
  /** Strip punctuation before comparison. Defaults to true. */
  ignorePunctuation?: boolean;
  /** Remove English stopwords before comparison. Defaults to false. */
  stopwords?: boolean;
  /** Required fraction (0..1) of salient expected terms present in output. */
  minTermCoverage?: number;
}

export interface RegexAssertion extends BaseAssertion {
  type: 'regex';
  /** One or more patterns. */
  pattern: string | string[];
  /** JavaScript regex flags. Defaults to `i` for `none` matching, else none. */
  flags?: string;
  /**
   * `any` — at least one pattern must match (default).
   * `all` — every pattern must match.
   * `none` — no pattern may match.
   */
  match?: 'any' | 'all' | 'none';
}

export interface JsonSchemaAssertion extends BaseAssertion {
  type: 'jsonSchema';
  /** JSON Schema (draft-07 compatible subset). */
  schema: Record<string, unknown>;
  /**
   * How to obtain JSON from the model output.
   * `auto` (default) tries strict parse, then fenced code blocks, then braces.
   */
  extract?: 'auto' | 'strict' | 'markdown' | 'first' | 'last';
}

export interface KeywordsAssertion extends BaseAssertion {
  type: 'keywords';
  /** Every keyword must be present. */
  required?: string[];
  /** At least one keyword must be present. */
  anyOf?: string[];
  /** No keyword may be present. */
  prohibited?: string[];
  /** Alias of `prohibited` kept for readability. */
  none?: string[];
  /** Require at least N of `required`. */
  minRequired?: number;
  /** Case-sensitive matching. Defaults to false. */
  caseSensitive?: boolean;
  /** Match on word boundaries. Defaults to false. */
  wholeWord?: boolean;
}

export interface ContainsAssertion extends BaseAssertion {
  type: 'contains';
  /** Substring that must (or must not) appear. */
  value: string;
  /** Case-insensitive. Defaults to true. */
  ignoreCase?: boolean;
  /** Invert the check. */
  negate?: boolean;
}

export interface LengthAssertion extends BaseAssertion {
  type: 'length';
  min?: number;
  max?: number;
  /** Measurement unit. Defaults to `chars`. */
  unit?: 'chars' | 'words' | 'sentences' | 'lines' | 'tokens';
  /** Approximate token count using a word/char heuristic. */
  tokenRatio?: number;
}

export interface CustomAssertion extends BaseAssertion {
  type: 'custom';
  /** Name of a validator registered on the engine. */
  validator: string;
  /** Arbitrary options forwarded to the validator. */
  options?: Record<string, unknown>;
}

export type Assertion =
  | SemanticAssertion
  | RegexAssertion
  | JsonSchemaAssertion
  | KeywordsAssertion
  | ContainsAssertion
  | LengthAssertion
  | CustomAssertion;

export interface PromptFixture {
  /** Stable identifier, unique inside a suite. */
  id: string;
  title?: string;
  description?: string;
  tags?: string[];
  /** System prompt for this case. */
  system?: string;
  /** The user prompt, or a full message list. */
  prompt: string | PromptMessage[];
  /** Template variables interpolated into the prompt via `{{var}}`. */
  variables?: Record<string, string | number | boolean>;
  /** Assertions evaluated against the model output. */
  assertions?: Assertion[];
  /** Per-fixture provider overrides. */
  provider?: Partial<ProviderConfig>;
  /** Per-fixture model override. */
  model?: string;
  /** Per-fixture timeout override. */
  timeoutMs?: number;
  /** Per-fixture retry count override. */
  retries?: number;
  /** Arbitrary metadata carried into reports. */
  metadata?: Record<string, unknown>;
  /** Skip this fixture without deleting it. */
  skip?: boolean;
  /** Static response used by the mock provider (overrides rules). */
  mockResponse?: string;
  /** Freeze the model output to this value (bypasses the provider). */
  frozenOutput?: string;
  /** Comparison baseline for drift detection. */
  baseline?: {
    promptHash?: string;
    model?: string;
  };
}

export interface SuiteDefaults {
  assertions?: Assertion[];
  provider?: Partial<ProviderConfig>;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  system?: string;
}

export interface TestSuite {
  name: string;
  description?: string;
  version?: number;
  tags?: string[];
  defaults?: SuiteDefaults;
  fixtures: PromptFixture[];
}

export interface SuiteFile extends TestSuite {
  $schema?: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface SuiteSource {
  /** Path or glob relative to the config file. */
  path: string;
  /** Optional explicit suite name override. */
  name?: string;
}

export interface PromptGuardConfig {
  $schema?: string;
  version: 1;
  /** Suite files to load. */
  suites: SuiteSource[];
  /** Where run reports are written. */
  outputDir: string;
  /** Named providers available to suites/fixtures. */
  providers: Record<string, ProviderConfig>;
  /** Provider used when a fixture does not name one. */
  defaultProvider: string;
  defaultModel?: string;
  /** Maximum fixtures executed in parallel. */
  concurrency: number;
  /** Default per-fixture timeout. */
  timeoutMs: number;
  /** Default retry count for transient provider errors. */
  retries: number;
  /** Assertions applied to every fixture that does not define its own. */
  defaultAssertions?: Assertion[];
  /** Report artefacts. */
  report: {
    formats: Array<'json' | 'junit'>;
    /** Number of historical runs to keep in the output directory. */
    keepRuns: number;
  };
  /** Environment variable names exposed for `{{var}}` interpolation. */
  env?: Record<string, string>;
  /** Colour output. */
  color?: 'auto' | 'always' | 'never';
  /** Fail the process when any case fails. Defaults to true. */
  bail?: boolean;
}

export interface ResolvedProvider extends ProviderConfig {
  /** Name of the provider entry in the config file. */
  name: string;
}

/* -------------------------------------------------------------------------- */
/* Run results & reports                                                       */
/* -------------------------------------------------------------------------- */

export type AssertionStatus =
  | 'passed'
  | 'failed'
  | 'warned'
  | 'skipped'
  | 'errored';

export interface AssertionResult {
  name: string;
  type: AssertionType;
  status: AssertionStatus;
  passed: boolean;
  message: string;
  expected?: unknown;
  actual?: unknown;
  /** Similarity score in [0, 1] for semantic assertions. */
  score?: number;
  /** Additional machine readable context. */
  details?: Record<string, unknown>;
  durationMs: number;
}

export type FixtureStatus = 'passed' | 'failed' | 'errored' | 'skipped';

export interface FixtureResult {
  id: string;
  title?: string;
  suite: string;
  status: FixtureStatus;
  tags: string[];
  /** Rendered prompt actually sent to the provider. */
  prompt: string;
  system?: string;
  /** Raw model output. */
  output?: string;
  /** Prompt fingerprint, used to detect prompt drift between runs. */
  promptHash: string;
  /** Model that produced the output. */
  model?: string;
  provider: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  assertions: AssertionResult[];
  /** Error message when the provider or the harness failed. */
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface RunTotals {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  durationMs: number;
}

export interface RunSummary {
  passRate: number;
  /** Pass rate per tag. */
  byTag: Record<string, { total: number; passed: number; passRate: number }>;
  /** Counts per assertion type. */
  assertionCounts: Record<string, { total: number; passed: number; failed: number }>;
}

export interface EnvironmentInfo {
  node: string;
  platform: string;
  arch: string;
  promptGuardVersion: string;
  cwd: string;
  /** Detected git commit, when available. */
  gitCommit?: string;
}

export interface RunConfigSnapshot {
  suite: string;
  provider: string;
  model?: string;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  filters: {
    tags?: string[];
    ids?: string[];
  };
}

export interface RunReport {
  schemaVersion: typeof RUN_REPORT_SCHEMA_VERSION;
  runId: string;
  label?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: RunConfigSnapshot;
  totals: RunTotals;
  summary: RunSummary;
  results: FixtureResult[];
  environment: EnvironmentInfo;
}

export interface CaseComparison {
  suite: string;
  id: string;
  title?: string;
  /** `changed` | `unchanged` | `added` | `removed` */
  change: 'changed' | 'unchanged' | 'added' | 'removed';
  statusA?: FixtureStatus;
  statusB?: FixtureStatus;
  /** `regressed` (A passed, B failed) | `fixed` (A failed, B passed) | `stable`. */
  verdict: 'regressed' | 'fixed' | 'stable' | 'added' | 'removed';
  promptChanged: boolean;
  promptHashA?: string;
  promptHashB?: string;
  modelA?: string;
  modelB?: string;
  modelChanged: boolean;
  outputSimilarity: number;
  assertionChanges: Array<{
    name: string;
    type: AssertionType;
    statusA?: AssertionStatus;
    statusB?: AssertionStatus;
    change: 'added' | 'removed' | 'regressed' | 'fixed' | 'unchanged';
  }>;
  outputA?: string;
  outputB?: string;
  durationDeltaMs?: number;
}

export interface ComparisonTotals {
  total: number;
  changed: number;
  unchanged: number;
  added: number;
  removed: number;
  /** Cases that passed in run A and fail in run B. */
  regressed: number;
  /** Cases that failed in run A and pass in run B. */
  fixed: number;
  /** Cases introduced by run B that do not pass. */
  newFailures: number;
  /** Individual assertions that went from passing to failing. */
  regressedAssertions: number;
  /** Individual assertions that went from failing to passing. */
  fixedAssertions: number;
}

export interface ComparisonReport {
  schemaVersion: typeof COMPARISON_REPORT_SCHEMA_VERSION;
  createdAt: string;
  runA: { runId: string; startedAt: string; label?: string; model?: string };
  runB: { runId: string; startedAt: string; label?: string; model?: string };
  drift: {
    modelChanged: boolean;
    modelA?: string;
    modelB?: string;
    promptChangedCount: number;
    suiteChanged: boolean;
  };
  totals: ComparisonTotals;
  cases: CaseComparison[];
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** Optional pointer to the offending suite/fixture. */
  where?: string;
}
