import { createHash } from 'node:crypto';

/** Stable, order-independent hash of a plain object. */
export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

/** Stable JSON stringify: object keys are always emitted in sorted order. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

/** SHA-256 hex digest. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short (12 char) fingerprint, readable enough to paste into tickets. */
export function shortHash(input: string): string {
  return sha256(input).slice(0, 12);
}
