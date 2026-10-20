/** Typed error hierarchy for prompt-guard. */

export class PromptGuardError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = 'PG_ERROR', details?: Record<string, unknown>) {
    super(message);
    this.name = 'PromptGuardError';
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends PromptGuardError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PG_CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

export class SuiteError extends PromptGuardError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PG_SUITE_ERROR', details);
    this.name = 'SuiteError';
  }
}

export class ProviderError extends PromptGuardError {
  readonly status?: number;

  constructor(message: string, status?: number, details?: Record<string, unknown>) {
    super(message, 'PG_PROVIDER_ERROR', details);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export class AssertionError extends PromptGuardError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PG_ASSERTION_ERROR', details);
    this.name = 'AssertionError';
  }
}

export class CliError extends PromptGuardError {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1, details?: Record<string, unknown>) {
    super(message, 'PG_CLI_ERROR', details);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
