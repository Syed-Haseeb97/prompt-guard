import type { RunReport } from '../../core/types.js';
import { writeJsonFile, writeTextFile } from '../../utils/fs.js';
import path from 'node:path';

export interface WriteRunArtifactsOptions {
  /** Directory where run artefacts are stored. */
  outputDir: string;
  /** The report to persist. */
  report: RunReport;
  /** Formats to emit. */
  formats: Array<'json' | 'junit'>;
  /** Label used in file names. */
  label?: string;
}

export interface WriteRunArtifactsResult {
  jsonPath?: string;
  junitPath?: string;
  files: string[];
}

/** Build the artefact file name for a run. */
export function runFileName(report: RunReport, extension: string): string {
  const label = report.label ? `-${report.label.replace(/[^a-zA-Z0-9._-]+/g, '-')}` : '';
  return `${report.runId}${label}.${extension}`;
}

/** Write the JSON report and (optionally) a JUnit XML report. */
export async function writeRunArtifacts(
  options: WriteRunArtifactsOptions,
): Promise<WriteRunArtifactsResult> {
  const { outputDir, report, formats } = options;
  const result: WriteRunArtifactsResult = { files: [] };

  if (formats.includes('json')) {
    const jsonPath = path.join(outputDir, runFileName(report, 'json'));
    await writeJsonFile(jsonPath, report);
    result.jsonPath = jsonPath;
    result.files.push(jsonPath);
  }

  if (formats.includes('junit')) {
    const junitPath = path.join(outputDir, runFileName(report, 'xml'));
    await writeTextFile(junitPath, toJUnitXml(report));
    result.junitPath = junitPath;
    result.files.push(junitPath);
  }

  return result;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // strip control characters that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Render a run report as JUnit XML (compatible with CI test reporters). */
export function toJUnitXml(report: RunReport): string {
  const suites = new Map<string, typeof report.results>();
  for (const result of report.results) {
    const bucket = suites.get(result.suite) ?? [];
    bucket.push(result);
    suites.set(result.suite, bucket);
  }

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="prompt-guard" tests="${report.totals.total}" failures="${
      report.totals.failed + report.totals.errored
    }" skipped="${report.totals.skipped}" time="${(report.durationMs / 1000).toFixed(3)}">`,
  );

  for (const [suiteName, results] of suites) {
    const failures = results.filter((r) => r.status === 'failed' || r.status === 'errored').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const time = results.reduce((acc, r) => acc + r.durationMs, 0) / 1000;
    lines.push(
      `  <testsuite name="${escapeXml(suiteName)}" tests="${results.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">`,
    );

    for (const result of results) {
      const classname = escapeXml(result.suite);
      // ASCII separator on purpose: CI report viewers differ in how they
      // decode non-ASCII characters in test names.
      const name = escapeXml(result.title ? `${result.id} - ${result.title}` : result.id);
      const time = (result.durationMs / 1000).toFixed(3);
      const isFailure = result.status === 'failed' || result.status === 'errored';

      if (isFailure) {
        const message = result.error?.message ?? failedAssertionMessage(result);
        lines.push(
          `    <testcase classname="${classname}" name="${name}" time="${time}">`,
        );
        lines.push(`      <failure message="${escapeXml(message)}" type="${result.status}"/>`);
        lines.push('    </testcase>');
      } else if (result.status === 'skipped') {
        lines.push(
          `    <testcase classname="${classname}" name="${name}" time="${time}">`,
        );
        lines.push('      <skipped/>');
        lines.push('    </testcase>');
      } else {
        lines.push(`    <testcase classname="${classname}" name="${name}" time="${time}"/>`);
      }
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

function failedAssertionMessage(result: RunReport['results'][number]): string {
  const failures = result.assertions.filter((a) => a.status === 'failed' || a.status === 'errored');
  if (failures.length === 0) return 'case failed';
  return failures.map((a) => `${a.name}: ${a.message}`).join(' | ');
}

/** Remove old run artefacts, keeping the newest `keep` entries. */
export async function pruneOldRuns(outputDir: string, keep: number): Promise<string[]> {
  if (keep <= 0) return [];
  const { promises: fs } = await import('node:fs');
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return [];
  }
  const runFiles = entries.filter((e) => /\.(json|xml)$/.test(e)).sort();
  const removable = runFiles.slice(0, Math.max(0, runFiles.length - keep));
  const removed: string[] = [];
  for (const file of removable) {
    const full = path.join(outputDir, file);
    try {
      await fs.unlink(full);
      removed.push(full);
    } catch {
      // ignore failures — pruning is best effort
    }
  }
  return removed;
}
