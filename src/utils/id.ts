import { randomBytes } from 'node:crypto';

/** URL-safe random identifier. */
export function randomId(bytes = 6): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Generate a filesystem-safe run id: `20240115T101500Z-a1b2c3`.
 */
export function generateRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${iso}-${randomId(4).toLowerCase()}`;
}
