import { createStylerFromOption, padVisible, truncateVisible, visibleWidth } from '../utils/ansi.js';
import type { Styler } from '../utils/ansi.js';
import type { FixtureResult, RunReport } from '../core/types.js';

export interface OutputContext {
  color: 'auto' | 'always' | 'never';
  quiet?: boolean;
  verbose?: boolean;
}

export function createOutputStyler(context: OutputContext): Styler {
  return createStylerFromOption(context.color);
}

const STATUS_ICON: Record<string, string> = {
  passed: '✔',
  failed: '✖',
  errored: '!',
  skipped: '–',
  warned: '▲',
};

const STATUS_COLOR: Record<string, (s: Styler, text: string) => string> = {
  passed: (s, t) => s.green(t),
  failed: (s, t) => s.red(t),
  errored: (s, t) => s.boldRed(t),
  skipped: (s, t) => s.gray(t),
  warned: (s, t) => s.yellow(t),
};

/** Render a compact per-case result line. */
export function renderCaseLine(
  result: FixtureResult,
  styler: Styler,
  width = 100,
): string {
  const icon = STATUS_ICON[result.status] ?? '?';
  const coloredIcon = (STATUS_COLOR[result.status] ?? ((_s: Styler, t: string) => t))(styler, icon);
  const label = result.title ? `${result.id} — ${result.title}` : result.id;
  const duration = `${result.durationMs.toFixed(0)}ms`;

  const prefix = `  ${coloredIcon} ${styler.bold(result.suite)} › ${label}`;
  const suffix = styler.dim(` ${duration}`);
  const available = width - visibleWidth(prefix) - visibleWidth(suffix) - 1;
  const truncated = available > 10 ? truncateVisible(prefix, width - visibleWidth(suffix) - 1) : prefix;
  return `${truncated}${suffix}`;
}

/** Render the summary block printed at the end of a run. */
export function renderSummary(report: RunReport, styler: Styler): string {
  const lines: string[] = [];
  const { totals, summary } = report;

  const passedPct = (summary.passRate * 100).toFixed(1);
  const head =
    totals.failed + totals.errored === 0
      ? styler.boldGreen(`✔ ${totals.passed}/${totals.total} passed (${passedPct}%)`)
      : styler.boldRed(
          `✖ ${totals.passed}/${totals.total} passed (${passedPct}%) — ${totals.failed} failed, ${totals.errored} errored`,
        );

  lines.push('');
  lines.push(head);
  lines.push(
    styler.dim(
      `  total ${totals.total} · skipped ${totals.skipped} · duration ${(totals.durationMs / 1000).toFixed(2)}s · run ${report.runId}`,
    ),
  );

  const tagEntries = Object.entries(summary.byTag);
  if (tagEntries.length > 0) {
    lines.push('');
    lines.push(styler.bold('  Tags'));
    const width = Math.max(...tagEntries.map(([tag]) => tag.length));
    for (const [tag, stats] of tagEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = (stats.passRate * 100).toFixed(0).padStart(3);
      const color = stats.passRate === 1 ? styler.green : stats.passRate >= 0.5 ? styler.yellow : styler.red;
      lines.push(`    ${padVisible(tag, width)}  ${color(`${pct}%`)}  (${stats.passed}/${stats.total})`);
    }
  }

  const assertionEntries = Object.entries(summary.assertionCounts);
  if (assertionEntries.length > 0) {
    lines.push('');
    lines.push(styler.bold('  Assertions'));
    const width = Math.max(...assertionEntries.map(([type]) => type.length));
    for (const [type, stats] of assertionEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
      const color = stats.failed === 0 ? styler.green : styler.red;
      lines.push(
        `    ${padVisible(type, width)}  ${color(`${stats.passed}/${stats.total} passed`)}`,
      );
    }
  }

  return lines.join('\n');
}

/** Render the failure details for every failing case. */
export function renderFailures(report: RunReport, styler: Styler, limit = 20): string {
  const failures = report.results.filter(
    (r) => r.status === 'failed' || r.status === 'errored',
  );
  if (failures.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push(styler.boldRed(`  ${failures.length} failing case${failures.length === 1 ? '' : 's'}`));

  for (const failure of failures.slice(0, limit)) {
    lines.push('');
    lines.push(`  ${styler.bold(failure.suite)} › ${styler.bold(failure.id)}${failure.title ? ` — ${failure.title}` : ''}`);
    if (failure.error) {
      lines.push(`    ${styler.red('error')}: ${failure.error.message}`);
    }
    const bad = failure.assertions.filter((a) => a.status === 'failed' || a.status === 'errored');
    for (const assertion of bad) {
      lines.push(`    ${styler.red('✖')} ${styler.bold(assertion.name)} [${assertion.type}]`);
      lines.push(`      ${assertion.message}`);
      if (assertion.score !== undefined) {
        lines.push(styler.dim(`      score: ${assertion.score.toFixed(3)}`));
      }
    }
    if (failure.output !== undefined) {
      const preview = failure.output.length > 400 ? `${failure.output.slice(0, 400)}…` : failure.output;
      lines.push(styler.dim(`    output: ${preview.replace(/\n/g, ' ')}`));
    }
  }

  if (failures.length > limit) {
    lines.push('');
    lines.push(styler.dim(`  … and ${failures.length - limit} more`));
  }

  return lines.join('\n');
}
