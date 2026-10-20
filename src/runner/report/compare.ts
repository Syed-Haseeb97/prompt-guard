import path from 'node:path';
import { readJsonFile, pathExists } from '../../utils/fs.js';
import {
  COMPARISON_REPORT_SCHEMA_VERSION,
  type AssertionResult,
  type AssertionStatus,
  type CaseComparison,
  type ComparisonReport,
  type FixtureResult,
  type RunReport,
} from '../../core/types.js';
import { semanticSimilarity } from '../assertions/semantic.js';

function caseKey(result: Pick<FixtureResult, 'suite' | 'id'>): string {
  return `${result.suite}::${result.id}`;
}

function assertionMap(results: AssertionResult[]): Map<string, AssertionResult> {
  const map = new Map<string, AssertionResult>();
  for (const assertion of results) {
    map.set(assertion.name, assertion);
  }
  return map;
}

function statusChange(
  a: AssertionStatus | undefined,
  b: AssertionStatus | undefined,
): CaseComparison['assertionChanges'][number]['change'] {
  if (a === undefined && b !== undefined) return 'added';
  if (a !== undefined && b === undefined) return 'removed';
  if (a === b) return 'unchanged';
  const failed = (s: AssertionStatus | undefined): boolean => s === 'failed' || s === 'errored';
  if (!failed(a) && failed(b)) return 'regressed';
  if (failed(a) && !failed(b)) return 'fixed';
  return 'unchanged';
}

/**
 * Compare two run reports.
 *
 * The comparison surfaces three kinds of drift:
 *  1. prompt drift — the rendered prompt hash changed between runs
 *  2. model drift — a different model produced the outputs
 *  3. behaviour drift — the outputs or assertion outcomes changed
 */
export function compareRuns(runA: RunReport, runB: RunReport): ComparisonReport {
  const mapA = new Map(runA.results.map((r) => [caseKey(r), r]));
  const mapB = new Map(runB.results.map((r) => [caseKey(r), r]));

  const keys = new Set<string>([...mapA.keys(), ...mapB.keys()]);
  const cases: CaseComparison[] = [];

  let changed = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;
  let regressed = 0;
  let fixed = 0;
  let newFailures = 0;
  let regressedAssertions = 0;
  let fixedAssertions = 0;
  let promptChangedCount = 0;

  for (const key of [...keys].sort()) {
    const a = mapA.get(key);
    const b = mapB.get(key);

    if (!a && b) {
      added += 1;
      if (b.status === 'failed' || b.status === 'errored') newFailures += 1;
      cases.push({
        suite: b.suite,
        id: b.id,
        title: b.title,
        change: 'added',
        statusA: undefined,
        statusB: b.status,
        verdict: 'added',
        promptChanged: false,
        promptHashB: b.promptHash,
        modelB: b.model,
        modelChanged: false,
        outputSimilarity: 0,
        assertionChanges: b.assertions.map((assertion) => ({
          name: assertion.name,
          type: assertion.type,
          statusB: assertion.status,
          change: 'added' as const,
        })),
        outputB: b.output,
      });
      continue;
    }

    if (a && !b) {
      removed += 1;
      cases.push({
        suite: a.suite,
        id: a.id,
        title: a.title,
        change: 'removed',
        statusA: a.status,
        statusB: undefined,
        verdict: 'removed',
        promptChanged: false,
        promptHashA: a.promptHash,
        modelA: a.model,
        modelChanged: false,
        outputSimilarity: 0,
        assertionChanges: a.assertions.map((assertion) => ({
          name: assertion.name,
          type: assertion.type,
          statusA: assertion.status,
          change: 'removed' as const,
        })),
        outputA: a.output,
      });
      continue;
    }

    if (!a || !b) continue;

    const promptChanged = a.promptHash !== b.promptHash;
    if (promptChanged) promptChangedCount += 1;
    const modelChanged = (a.model ?? '') !== (b.model ?? '');

    const outputSimilarity =
      a.output !== undefined && b.output !== undefined
        ? semanticSimilarity(a.output, b.output).score
        : 1;

    const assertionsA = assertionMap(a.assertions);
    const assertionsB = assertionMap(b.assertions);
    const assertionNames = new Set<string>([...assertionsA.keys(), ...assertionsB.keys()]);
    const assertionChanges: CaseComparison['assertionChanges'] = [];

    for (const assertionName of [...assertionNames].sort()) {
      const left = assertionsA.get(assertionName);
      const right = assertionsB.get(assertionName);
      const change = statusChange(left?.status, right?.status);
      assertionChanges.push({
        name: assertionName,
        type: right?.type ?? left?.type ?? 'custom',
        statusA: left?.status,
        statusB: right?.status,
        change,
      });
      if (change === 'regressed') regressedAssertions += 1;
      if (change === 'fixed') fixedAssertions += 1;
    }

    const statusChanged = a.status !== b.status;
    const outputsDiffer = (a.output ?? '') !== (b.output ?? '');
    const isChanged = statusChanged || outputsDiffer || promptChanged;

    let verdict: CaseComparison['verdict'];
    if (a.status === 'passed' && b.status !== 'passed') verdict = 'regressed';
    else if (a.status !== 'passed' && b.status === 'passed') verdict = 'fixed';
    else verdict = 'stable';

    if (verdict === 'regressed') regressed += 1;
    else if (verdict === 'fixed') fixed += 1;

    if (isChanged) changed += 1;
    else unchanged += 1;

    cases.push({
      suite: b.suite,
      id: b.id,
      title: b.title ?? a.title,
      change: isChanged ? 'changed' : 'unchanged',
      statusA: a.status,
      statusB: b.status,
      verdict,
      promptChanged,
      promptHashA: a.promptHash,
      promptHashB: b.promptHash,
      modelA: a.model,
      modelB: b.model,
      modelChanged,
      outputSimilarity,
      assertionChanges,
      outputA: a.output,
      outputB: b.output,
      durationDeltaMs: Number((b.durationMs - a.durationMs).toFixed(3)),
    });
  }

  const modelA = runA.config.model;
  const modelB = runB.config.model;

  return {
    schemaVersion: COMPARISON_REPORT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    runA: { runId: runA.runId, startedAt: runA.startedAt, label: runA.label, model: modelA },
    runB: { runId: runB.runId, startedAt: runB.startedAt, label: runB.label, model: modelB },
    drift: {
      modelChanged: (modelA ?? '') !== (modelB ?? ''),
      modelA,
      modelB,
      promptChangedCount,
      suiteChanged: runA.config.suite !== runB.config.suite,
    },
    totals: {
      total: cases.length,
      changed,
      unchanged,
      added,
      removed,
      regressed,
      fixed,
      newFailures,
      regressedAssertions,
      fixedAssertions,
    },
    cases,
  };
}

/** Read a run report from disk. */
export async function loadRunReport(filePath: string): Promise<RunReport> {
  const absolute = path.resolve(filePath);
  if (!(await pathExists(absolute))) {
    throw new Error(`run report not found: ${absolute}`);
  }
  const report = await readJsonFile<RunReport>(absolute);
  if (!report || typeof report !== 'object' || !Array.isArray(report.results)) {
    throw new Error(`${absolute} is not a valid prompt-guard run report`);
  }
  return report;
}

/**
 * Resolve a run reference.
 *
 * Accepts an absolute/relative file path, a bare run id, or a run id with the
 * `.json` suffix. Bare ids are looked up inside the output directory.
 */
export async function resolveRunReference(
  reference: string,
  outputDir: string,
): Promise<string> {
  const direct = path.resolve(reference);
  if (await pathExists(direct)) return direct;

  const candidates = [
    path.join(outputDir, reference),
    path.join(outputDir, `${reference}.json`),
    path.join(outputDir, `${reference}.xml`),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  const { promises: fs } = await import('node:fs');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    entries = [];
  }

  const jsonEntries = entries.filter(
    (entry) => entry.endsWith('.json') && !entry.startsWith('comparison-'),
  );
  const matches = jsonEntries.filter((entry) => {
    const base = entry.slice(0, -'.json'.length);
    return (
      base === reference ||
      base.endsWith(`-${reference}`) ||
      base.startsWith(`${reference}-`) ||
      base.includes(reference)
    );
  });
  if (matches.length > 0) {
    // Prefer the most recently written run.
    const withTimes = await Promise.all(
      matches.map(async (entry) => {
        const full = path.join(outputDir, entry);
        try {
          const stat = await fs.stat(full);
          return { entry, time: stat.mtimeMs };
        } catch {
          return { entry, time: 0 };
        }
      }),
    );
    withTimes.sort((a, b) => b.time - a.time);
    const newest = withTimes[0];
    if (newest) return path.join(outputDir, newest.entry);
  }

  throw new Error(
    `could not resolve run "${reference}". Looked in ${outputDir}. Provide a path to a run report JSON file.`,
  );
}
