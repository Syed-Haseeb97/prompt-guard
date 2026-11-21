import path from 'node:path';
import { CliError } from '../../core/errors.js';
import { loadConfig } from '../../core/config.js';
import { evaluateThresholds, loadBenchmark } from '../../core/benchmark.js';
import type { BenchmarkConfig } from '../../core/benchmark.js';
import { Logger } from '../../core/logger.js';
import { loadSuites } from '../../runner/suiteLoader.js';
import { RegressionEngine, resolveOutputDir } from '../../runner/regressionEngine.js';
import type { EngineFilters, ProgressEvent } from '../../runner/regressionEngine.js';
import { pruneOldRuns, writeRunArtifacts } from '../../runner/report/jsonReport.js';
import {
  createOutputStyler,
  renderCaseLine,
  renderFailures,
  renderMatrixScorecard,
  renderSummary,
} from '../output.js';
import type { MatrixRow, OutputContext } from '../output.js';
import { flagBoolean, flagList, flagNumber, flagString } from '../args.js';
import type { ParsedArgs } from '../args.js';

export interface RunOptions extends OutputContext {
  cwd: string;
  configPath?: string;
  provider?: string;
  model?: string;
  filters: EngineFilters;
  label?: string;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  outputDir?: string;
  formats?: Array<'json' | 'junit'>;
  bail?: boolean;
  /** Print the raw report JSON to stdout. */
  json?: boolean;
  /** Print the report JSON to stdout instead of the human summary. */
  reportJson?: boolean;
}

export interface RunResult {
  exitCode: number;
  reportPath?: string;
  junitPath?: string;
  benchmark?: {
    name: string;
    passed: boolean;
    violations: string[];
  };
}

/** Exit code used when a benchmark threshold or budget is violated. */
export const BENCHMARK_EXIT_CODE = 3;

/** Execute `prompt-guard run`. */
export async function runRunCommand(args: ParsedArgs, context: OutputContext): Promise<RunResult> {
  const styler = createOutputStyler(context);
  const cwd = process.cwd();

  const configPath = flagString(args, 'config');
  const loaded = await loadConfig(cwd, configPath);
  const config = loaded.config;

  // A benchmark file pins the provider/model and adds acceptance thresholds.
  const benchmarkPath = flagString(args, 'benchmark');
  let benchmark: BenchmarkConfig | undefined;
  if (benchmarkPath) {
    const loadedBenchmark = await loadBenchmark(benchmarkPath, cwd);
    benchmark = loadedBenchmark.benchmark;
    if (benchmark.defaultProvider) {
      config.defaultProvider = benchmark.defaultProvider;
    }
    if (benchmark.providers) {
      config.providers = { ...config.providers, ...benchmark.providers };
    }
  }

  for (const warning of loaded.warnings) {
    if (!context.quiet) process.stderr.write(`${styler.yellow('warning')}: ${warning}\n`);
  }

  const filters: EngineFilters = {
    tags: flagList(args, 'tag').length ? flagList(args, 'tag') : undefined,
    excludeTags: flagList(args, 'exclude-tag').length ? flagList(args, 'exclude-tag') : undefined,
    ids: flagList(args, 'id').length ? flagList(args, 'id') : undefined,
    search: flagString(args, 'search'),
  };

  const providerName = flagString(args, 'provider') ?? benchmark?.defaultProvider;
  const model = flagString(args, 'model') ?? benchmark?.model;
  const label = flagString(args, 'label');
  const concurrency = flagNumber(args, 'concurrency');
  const timeoutMs = flagNumber(args, 'timeout');
  const retries = flagNumber(args, 'retries');
  const bail = flagBoolean(args, 'bail', config.bail);
  const cache = flagBoolean(args, 'cache', config.cache?.enabled ?? true);
  const matrixFlag = flagString(args, 'matrix');
  const outputOverride = flagString(args, 'out');
  const formatFlag = flagString(args, 'format');
  const formats: Array<'json' | 'junit'> = formatFlag
    ? (formatFlag.split(',').map((f) => f.trim()).filter((f): f is 'json' | 'junit' => f === 'json' || f === 'junit'))
    : config.report.formats;
  const printJson = flagBoolean(args, 'json') || flagBoolean(args, 'report-json');

  const suiteSources = benchmark?.suites.length ? benchmark.suites : config.suites;
  const suites = await loadSuites(suiteSources, loaded.rootDir);
  if (suites.length === 0) {
    throw new CliError('no suites configured — run `prompt-guard init` first', 1);
  }

  const outputDir = outputOverride
    ? path.resolve(cwd, outputOverride)
    : resolveOutputDir(config, loaded.rootDir);

  const logger = new Logger({
    level: context.verbose ? 'info' : 'warn',
    sink: (line) => process.stderr.write(`${line}\n`),
    prefix: styler.dim('pg '),
  });

  if (matrixFlag) {
    const matrixProviders = matrixFlag
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (matrixProviders.length === 0) {
      throw new CliError('--matrix requires at least one provider (e.g. --matrix openai,freellmapi)', 1);
    }

    const matrixReports: Array<{ provider: string; model: string; report: any }> = [];
    let anyFailed = false;

    for (const pName of matrixProviders) {
      if (!context.quiet && !printJson) {
        process.stderr.write(`\n  ${styler.bold(`Evaluating provider [${pName}]`)}\n`);
      }

      const matrixEngine = new RegressionEngine({
        config,
        suites: suites.map((s) => s.suite),
        providerName: pName,
        model,
        filters,
        concurrency,
        timeoutMs,
        retries,
        label: label ? `${label}-${pName}` : pName,
        logger,
        cwd: loaded.rootDir,
        bail,
        cache,
        onProgress: (event: ProgressEvent) => {
          if (context.quiet || printJson) return;
          if (event.type === 'case-end') {
            process.stderr.write(`${renderCaseLine(event.result, styler)}\n`);
          }
        },
      });

      const report = await matrixEngine.run();
      const pModel = report.results[0]?.model ?? config.providers[pName]?.model ?? 'default';
      matrixReports.push({ provider: pName, model: pModel, report });

      await writeRunArtifacts({
        outputDir,
        report,
        formats,
        label: label ? `${label}-${pName}` : pName,
      });

      if (report.totals.failed + report.totals.errored > 0) {
        anyFailed = true;
      }
    }

    if (printJson) {
      process.stdout.write(
        `${JSON.stringify({ matrix: matrixReports.map((m) => ({ provider: m.provider, model: m.model, totals: m.report.totals, summary: m.report.summary })) }, null, 2)}\n`,
      );
    } else if (!context.quiet) {
      const rows: MatrixRow[] = matrixReports.map((m) => {
        const latencies = m.report.results.map((r: any) => r.durationMs);
        const avgLatencyMs =
          latencies.length > 0
            ? latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length
            : 0;
        return {
          provider: m.provider,
          model: m.model,
          total: m.report.totals.total,
          passed: m.report.totals.passed,
          failed: m.report.totals.failed + m.report.totals.errored,
          passRate: m.report.summary.passRate,
          avgLatencyMs,
        };
      });
      process.stdout.write(renderMatrixScorecard(rows, styler));
    }

    return {
      exitCode: anyFailed ? 1 : 0,
    };
  }

  let printedCount = 0;
  const engine = new RegressionEngine({
    config,
    suites: suites.map((s) => s.suite),
    providerName,
    model,
    filters,
    concurrency,
    timeoutMs,
    retries,
    label,
    logger,
    cwd: loaded.rootDir,
    bail,
    cache,
    onProgress: (event: ProgressEvent) => {
      if (context.quiet) return;
      if (event.type === 'case-end') {
        printedCount += 1;
        process.stderr.write(`${renderCaseLine(event.result, styler)}\n`);
      }
    },
  });

  const report = await engine.run();

  const artifacts = await writeRunArtifacts({
    outputDir,
    report,
    formats,
    label,
  });

  if (config.report.keepRuns > 0) {
    await pruneOldRuns(outputDir, config.report.keepRuns);
  }

  if (printJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!context.quiet) {
    process.stdout.write(`${renderSummary(report, styler)}\n`);
    const failures = renderFailures(report, styler);
    if (failures) process.stdout.write(`${failures}\n`);
    if (artifacts.jsonPath) {
      process.stdout.write(styler.dim(`\n  report: ${artifacts.jsonPath}\n`));
    }
    if (artifacts.junitPath) {
      process.stdout.write(styler.dim(`  junit:  ${artifacts.junitPath}\n`));
    }
  }

  let benchmarkResult: RunResult['benchmark'];
  if (benchmark) {
    const evaluation = evaluateThresholds(benchmark, report);
    benchmarkResult = {
      name: benchmark.name,
      passed: evaluation.passed,
      violations: evaluation.violations.map((v) => v.message),
    };
    if (!context.quiet && !printJson) {
      process.stdout.write('\n');
      if (evaluation.passed) {
        process.stdout.write(
          `${styler.boldGreen(`✔ benchmark "${benchmark.name}" satisfied`)}\n`,
        );
      } else {
        process.stdout.write(
          `${styler.boldRed(`✖ benchmark "${benchmark.name}" violated ${evaluation.violations.length} threshold(s)`)}\n`,
        );
        for (const violation of evaluation.violations) {
          process.stdout.write(`  ${styler.red('·')} ${violation.message}\n`);
        }
      }
    }
  }

  const failed = report.totals.failed + report.totals.errored;
  const thresholdFailed = benchmarkResult ? !benchmarkResult.passed : false;

  return {
    exitCode: thresholdFailed ? BENCHMARK_EXIT_CODE : failed > 0 ? 1 : 0,
    reportPath: artifacts.jsonPath,
    junitPath: artifacts.junitPath,
    benchmark: benchmarkResult,
  };
}
