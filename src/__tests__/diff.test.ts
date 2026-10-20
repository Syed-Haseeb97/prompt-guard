import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, diffTokens, diffWords, safeDiff } from '../runner/diff/textDiff.js';
import { buildDiffRows, detectWidth, renderSideBySide } from '../runner/diff/sideBySide.js';

describe('diffTokens', () => {
  it('detects no differences for identical input', () => {
    const segments = diffTokens(['a', 'b'], ['a', 'b']);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.op).toBe('equal');
  });

  it('reports insertions and deletions', () => {
    const segments = diffTokens(['a', 'b', 'c'], ['a', 'x', 'c']);
    const ops = segments.map((s) => s.op);
    expect(ops).toContain('delete');
    expect(ops).toContain('insert');
    expect(diffStats(segments).added).toBeGreaterThan(0);
  });

  it('handles empty inputs', () => {
    expect(diffTokens([], [])).toHaveLength(0);
    expect(diffTokens([], ['a'])[0]?.op).toBe('insert');
    expect(diffTokens(['a'], [])[0]?.op).toBe('delete');
  });
});

describe('diffWords / diffLines', () => {
  it('produces word level segments', () => {
    const segments = diffWords('the cat sat', 'the dog sat');
    expect(segments.map((s) => s.op)).toEqual(['equal', 'delete', 'insert', 'equal']);
  });

  it('produces line level segments', () => {
    const segments = diffLines('a\nb\nc', 'a\nx\nc');
    expect(segments.map((s) => s.op)).toEqual(['equal', 'delete', 'insert', 'equal']);
  });

  it('falls back to a block diff for very large inputs', () => {
    const a = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const b = Array.from({ length: 300 }, (_, i) => `other ${i}`).join('\n');
    const segments = safeDiff(a, b, 'line', 100);
    expect(segments.length).toBeGreaterThan(0);
  });
});

describe('diffStats', () => {
  it('flags identical content', () => {
    const stats = diffStats(diffWords('same text', 'same text'));
    expect(stats.identical).toBe(true);
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(0);
  });
});

describe('buildDiffRows', () => {
  it('aligns changed words into paired rows', () => {
    const rows = buildDiffRows(diffWords('the cat sat', 'the dog sat'));
    const changed = rows.filter((r) => r.type === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.left).toBe('cat');
    expect(changed[0]?.right).toBe('dog');
  });

  it('collapses consecutive unchanged words into one row', () => {
    const rows = buildDiffRows(diffWords('the cat sat', 'the dog sat'));
    const equal = rows.filter((r) => r.type === 'equal');
    expect(equal.length).toBeLessThanOrEqual(2);
    expect(equal[0]?.left).toContain('the');
  });

  it('marks pure insertions as added rows', () => {
    const rows = buildDiffRows(diffWords('a b', 'a b c'));
    const added = rows.filter((r) => r.type === 'added');
    expect(added.length).toBeGreaterThan(0);
    expect(added[0]?.left).toBe('');
  });

  it('marks pure deletions as removed rows', () => {
    const rows = buildDiffRows(diffWords('a b c', 'a b'));
    const removed = rows.filter((r) => r.type === 'removed');
    expect(removed.length).toBeGreaterThan(0);
    expect(removed[0]?.right).toBe('');
  });
});

describe('renderSideBySide', () => {
  it('renders a framed table with both columns', () => {
    const result = renderSideBySide('hello world', 'hello there', {
      leftTitle: 'run A',
      rightTitle: 'run B',
      color: 'never',
      width: 80,
    });
    expect(result.text).toContain('run A');
    expect(result.text).toContain('run B');
    expect(result.text).toContain('┌');
    expect(result.text).toContain('└');
    expect(result.text).toContain('│');
  });

  it('reports the diff statistics', () => {
    const result = renderSideBySide('alpha beta', 'alpha gamma', { color: 'never' });
    expect(result.stats.identical).toBe(false);
    expect(result.stats.added).toBeGreaterThan(0);
  });

  it('hides unchanged rows when asked', () => {
    const result = renderSideBySide('keep this text here', 'keep this text here', {
      color: 'never',
      showUnchanged: false,
    });
    expect(result.rows).toHaveLength(0);
  });

  it('truncates very long output', () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const result = renderSideBySide(long, long, { color: 'never', maxRows: 10 });
    expect(result.text).toContain('truncated');
  });
});

describe('detectWidth', () => {
  it('returns a sane terminal width', () => {
    const width = detectWidth();
    expect(width).toBeGreaterThanOrEqual(40);
    expect(width).toBeLessThanOrEqual(160);
  });
});
