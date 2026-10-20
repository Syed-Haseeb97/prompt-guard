/**
 * prompt-guard — public API.
 *
 * The CLI is a thin wrapper around these exports, so the framework can be
 * embedded in an existing test suite (Vitest, Jest, Playwright, ...).
 */

export * from './core/types.js';
export * from './core/errors.js';
export * from './core/config.js';
export * from './core/benchmark.js';
export * from './core/logger.js';

export * from './runner/regressionEngine.js';
export * from './runner/suiteLoader.js';
export * from './runner/template.js';

export * from './runner/assertions/index.js';
export * from './runner/assertions/types.js';
export * from './runner/assertions/misc.js';

export * from './runner/providers/index.js';

export * from './runner/diff/textDiff.js';
export * from './runner/diff/sideBySide.js';

export * from './runner/report/jsonReport.js';
export * from './runner/report/compare.js';

export { runInit } from './cli/commands/init.js';
export { runRunCommand } from './cli/commands/run.js';
export { runCompareCommand, compareOptionsFromArgs } from './cli/commands/compare.js';
export { parseArgs, flagBoolean, flagList, flagNumber, flagString } from './cli/args.js';
export { createOutputStyler, renderCaseLine, renderFailures, renderSummary } from './cli/output.js';

export const VERSION = '1.0.0';
