#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliError, PromptGuardError } from '../core/errors.js';
import { createOutputStyler } from './output.js';
import { flagBoolean, flagList, flagNumber, flagString, parseArgs } from './args.js';
import type { ParsedArgs } from './args.js';
import { runInit } from './commands/init.js';
import { runRunCommand } from './commands/run.js';
import { compareOptionsFromArgs, runCompareCommand } from './commands/compare.js';
import type { OutputContext } from './output.js';

const VERSION = '1.0.0';

const HELP = `
prompt-guard ${VERSION} — regression testing and guardrails for LLM prompts

USAGE
  prompt-guard <command> [options]

COMMANDS
  init                       Scaffold a prompt-guard project (config, suites, benchmarks)
  run                        Execute prompt fixtures and evaluate their outputs
  compare <runA> <runB>      Diff two runs and report regressions
  help                       Show this message
  version                    Print the version

RUN OPTIONS
  -c, --config <path>        Path to the config file
      --benchmark <path>      Benchmark file pinning the provider/model and thresholds
  -p, --provider <name>      Provider to use (from the "providers" section)
  -m, --model <id>           Model identifier to send to the provider
  -t, --tag <tag>            Only run fixtures with this tag (repeatable, comma separated)
      --exclude-tag <tag>    Skip fixtures carrying this tag (repeatable)
  -i, --id <id>              Only run these fixture ids (repeatable)
  -s, --search <text>        Only run fixtures whose id/title/description contains the text
  -n, --concurrency <n>      Number of fixtures executed in parallel
      --timeout <ms>         Per-fixture timeout in milliseconds
      --retries <n>          Retry count for transient provider errors
      --label <name>         Label stored in the run report
  -o, --out <dir>            Directory where run artefacts are written
  -f, --format <list>        Report formats: json,junit
      --bail                 Stop at the first failing case
      --json                 Print the raw run report JSON to stdout
  -q, --quiet                Suppress the human readable output
  -v, --verbose              Print diagnostic information
      --color <mode>         auto | always | never

COMPARE OPTIONS
      --max-cases <n>        Maximum number of changed cases rendered (default 10)
  -w, --width <n>            Width of the side-by-side diff
      --only-changed         Only render cases whose output changed (default true)
      --no-fail-on-regression
                             Always exit 0 even when regressions are detected
      --no-write             Do not write the comparison report to disk

EXAMPLES
  prompt-guard init
  prompt-guard run --provider openai --model gpt-4o-mini --tag billing
  prompt-guard run --benchmark benchmarks/baseline.benchmark.json
  prompt-guard run --label before --model gpt-4o-mini
  prompt-guard run --label after  --model gpt-4o-2024-08-06
  prompt-guard compare before after

EXIT CODES
  0  success
  1  one or more cases failed or errored
  2  usage error
  3  benchmark thresholds or budgets were violated
`;

function buildContext(args: ParsedArgs): OutputContext {
  const colorFlag = flagString(args, 'color');
  const color: OutputContext['color'] =
    colorFlag === 'always' || colorFlag === 'never' || colorFlag === 'auto' ? colorFlag : 'auto';
  return {
    color,
    quiet: flagBoolean(args, 'quiet', false),
    verbose: flagBoolean(args, 'verbose', false),
  };
}

/** Execute the CLI. Returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const context = buildContext(args);
  const styler = createOutputStyler(context);

  if (flagBoolean(args, 'help', false) || args.command === 'help' || args.command === '') {
    process.stdout.write(`${HELP}\n`);
    return args.command === '' ? 1 : 0;
  }

  if (args.command === 'version' || flagBoolean(args, 'version', false)) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    switch (args.command) {
      case 'init': {
        await runInit({
          cwd: process.cwd(),
          targetDir: flagString(args, 'dir') ?? flagString(args, 'target'),
          force: flagBoolean(args, 'force', false),
          noSamples: flagBoolean(args, 'no-samples', false),
          context,
        });
        return 0;
      }

      case 'run': {
        const result = await runRunCommand(args, context);
        return result.exitCode;
      }

      case 'compare': {
        const options = compareOptionsFromArgs(args, context);
        const result = await runCompareCommand(args, context, options);
        return result.exitCode;
      }

      default: {
        process.stderr.write(`${styler.red('error')}: unknown command "${args.command}"\n`);
        process.stderr.write(`${styler.dim('Run `prompt-guard help` to see the available commands.')}\n`);
        return 2;
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${styler.red('error')}: ${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof PromptGuardError) {
      process.stderr.write(`${styler.red('error')}: ${error.message}\n`);
      return 1;
    }
    const err = error as Error;
    process.stderr.write(`${styler.red('error')}: ${err?.message ?? String(error)}\n`);
    if (process.env.PROMPT_GUARD_DEBUG && err?.stack) {
      process.stderr.write(`${styler.dim(err.stack)}\n`);
    }
    return 1;
  }
}

/* c8 ignore start */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // Compare real paths: npm installs the CLI through a symlink and Windows
    // junctions resolve to their target, so a naive string comparison of
    // `import.meta.url` against `process.argv[1]` would fail.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`error: ${(error as Error)?.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */

export { HELP, VERSION };
export { flagList, flagNumber };
