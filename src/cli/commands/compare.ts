import path from 'node:path';
import { CliError } from '../../core/errors.js';
import { loadConfig } from '../../core/config.js';
import { resolveOutputDir } from '../../runner/regressionEngine.js';
import {
  compareRuns,
  loadRunReport,
  resolveRunReference,
} from '../../runner/report/compare.js';
import type { ComparisonReport } from '../../core/types.js';
import { writeJsonFile } from '../../utils/fs.js';
import { detectWidth, renderSideBySide } from '../../runner/diff/sideBySide.js';
import { createOutputStyler } from '../output.js';
import type { OutputContext } from '../output.js';
import { flagBoolean, flagNumber, flagString } from '../args.js';
import type { ParsedArgs } from '../args.js';

export interface CompareOptions extends OutputContext {
  cwd: string;
  configPath?: string;
  runA: string;
  runB: string;
  /** Write the comparison report to disk. */
  write?: boolean;
  /** Maximum number of cases to print in full. */
  maxCases?: number;
  /** Terminal width used for the side-by-side diff. */
  width?: number;
  /** Exit with code 1 when regressions are detected. */
  failOnRegression?: boolean;
  /** Only show cases whose output changed. */
  onlyChanged?: boolean;
}

export interface CompareResult {
  report: ComparisonReport;
  exitCode: number;
  reportPath?: string;
}

/** Execute `prompt-guard compare <runA> <runB>`. */
export async function runCompareCommand(
  args: ParsedArgs,
  context: OutputContext,
  options: CompareOptions,
): Promise<CompareResult> {
  const styler = createOutputStyler(context);

  if (!options.runA || !options.runB) {
    throw new CliError('compare requires two run references: prompt-guard compare <runA> <runB>', 2);
  }

  const loaded = await loadConfig(options.cwd, options.configPath);
  const outputDir = resolveOutputDir(loaded.config, loaded.rootDir);

  const pathA = await resolveRunReference(options.runA, outputDir);
  const pathB = await resolveRunReference(options.runB, outputDir);

  const runA = await loadRunReport(pathA);
  const runB = await loadRunReport(pathB);

  const report = compareRuns(runA, runB);

  const reportPath = path.join(
    outputDir,
    `comparison-${runA.runId}-vs-${runB.runId}.json`,
  );
  if (options.write !== false) {
    await writeJsonFile(reportPath, report);
  }

  if (!context.quiet) {
    const lines: string[] = [];
    lines.push('');
    lines.push(styler.bold('  Run comparison'));
    lines.push(
      `    ${styler.gray('A')}  ${runA.runId}${runA.label ? ` (${runA.label})` : ''}  ${styler.dim(
        `${runA.startedAt} · ${runA.totals.passed}/${runA.totals.total} passed`,
      )}`,
    );
    lines.push(
      `    ${styler.gray('B')}  ${runB.runId}${runB.label ? ` (${runB.label})` : ''}  ${styler.dim(
        `${runB.startedAt} · ${runB.totals.passed}/${runB.totals.total} passed`,
      )}`,
    );
    lines.push('');

    const { totals, drift } = report;
    lines.push(
      `    ${styler.bold('totals')}   ${totals.total} cases · ${styler.yellow(`${totals.changed} changed`)} · ` +
        `${totals.unchanged} unchanged · ${totals.added} added · ${totals.removed} removed`,
    );

    if (totals.regressed > 0) {
      lines.push(
        `    ${styler.boldRed('regressed')} ${totals.regressed} case(s) that previously passed now fail` +
          (totals.regressedAssertions !== totals.regressed
            ? styler.dim(` (${totals.regressedAssertions} assertion(s) regressed)`)
            : ''),
      );
    }
    if (totals.newFailures > 0) {
      lines.push(`    ${styler.boldRed('new failures')} ${totals.newFailures} newly added case(s) do not pass`);
    }
    if (totals.fixed > 0) {
      lines.push(
        `    ${styler.boldGreen('fixed')}     ${totals.fixed} case(s) now pass` +
          (totals.fixedAssertions !== totals.fixed
            ? styler.dim(` (${totals.fixedAssertions} assertion(s) fixed)`)
            : ''),
      );
    }

    if (drift.modelChanged) {
      lines.push(
        `    ${styler.boldYellow('model drift')}  ${drift.modelA ?? '(unknown)'} → ${drift.modelB ?? '(unknown)'}`,
      );
    }
    if (drift.promptChangedCount > 0) {
      lines.push(
        `    ${styler.boldYellow('prompt drift')} ${drift.promptChangedCount} case(s) had their prompt changed`,
      );
    }
    if (drift.suiteChanged) {
      lines.push(`    ${styler.boldYellow('suite drift')}  the set of suites differs between the runs`);
    }

    const interesting = report.cases.filter((c) =>
      options.onlyChanged
        ? c.change !== 'unchanged'
        : c.verdict === 'regressed' || c.verdict === 'fixed' || c.promptChanged || c.change !== 'unchanged',
    );

    const maxCases = options.maxCases ?? 10;
    const shown = interesting.slice(0, maxCases);

    if (shown.length > 0) {
      lines.push('');
      lines.push(styler.bold(`  Diff (${shown.length} of ${interesting.length} changed case(s))`));
      for (const comparison of shown) {
        lines.push('');
        const verdictLabel =
          comparison.verdict === 'regressed'
            ? styler.boldRed('REGRESSED')
            : comparison.verdict === 'fixed'
              ? styler.boldGreen('FIXED')
              : comparison.promptChanged
                ? styler.boldYellow('PROMPT CHANGED')
                : styler.bold('CHANGED');
        lines.push(
          `  ${verdictLabel} ${styler.bold(comparison.suite)} › ${styler.bold(comparison.id)}${
            comparison.title ? ` — ${comparison.title}` : ''
          }`,
        );
        const statusLine = `      status ${comparison.statusA ?? '—'} → ${comparison.statusB ?? '—'} · similarity ${(
          comparison.outputSimilarity * 100
        ).toFixed(0)}%`;
        lines.push(styler.dim(statusLine));

        for (const change of comparison.assertionChanges) {
          if (change.change === 'unchanged') continue;
          const marker =
            change.change === 'regressed'
              ? styler.red('regressed')
              : change.change === 'fixed'
                ? styler.green('fixed')
                : styler.gray(change.change);
          lines.push(
            `      ${marker} ${change.name} (${change.statusA ?? '—'} → ${change.statusB ?? '—'})`,
          );
        }

        if (comparison.outputA !== undefined && comparison.outputB !== undefined) {
          const diff = renderSideBySide(comparison.outputA, comparison.outputB, {
            leftTitle: `A · ${comparison.id}`,
            rightTitle: `B · ${comparison.id}`,
            width: options.width ?? detectWidth(),
            color: context.color,
            maxRows: 24,
            showUnchanged: false,
            context: 2,
          });
          lines.push(diff.text);
        }
      }
      if (interesting.length > maxCases) {
        lines.push('');
        lines.push(styler.dim(`  … and ${interesting.length - maxCases} more changed case(s)`));
      }
    }

    lines.push('');
    lines.push(styler.dim(`  comparison report: ${reportPath}`));
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  const hasRegression = report.totals.regressed > 0 || report.totals.newFailures > 0;
  const exitCode = hasRegression && options.failOnRegression !== false ? 1 : 0;

  return { report, exitCode, reportPath };
}

/** Read options for the compare command from parsed args. */
export function compareOptionsFromArgs(args: ParsedArgs, context: OutputContext): CompareOptions {
  return {
    ...context,
    cwd: process.cwd(),
    configPath: flagString(args, 'config'),
    runA: args.positionals[0] ?? '',
    runB: args.positionals[1] ?? '',
    write: flagBoolean(args, 'write', true),
    maxCases: flagNumber(args, 'max-cases', 10),
    width: flagNumber(args, 'width'),
    failOnRegression: flagBoolean(args, 'fail-on-regression', true),
    onlyChanged: flagBoolean(args, 'only-changed', true),
  };
}
