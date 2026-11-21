import type { Diagnostic, DiagnosticLevel } from './types.js';

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /** Where lines are written. Defaults to stdout. */
  sink?: LogSink;
  /** Minimum level to emit. */
  level?: DiagnosticLevel;
  /** Prefix used by the CLI. */
  prefix?: string;
  /** Suppress all output. */
  silent?: boolean;
  /** Shared diagnostics array. */
  diagnostics?: Diagnostic[];
}

const LEVEL_ORDER: Record<DiagnosticLevel, number> = { info: 0, warn: 1, error: 2 };

/** Tiny level-aware logger used by the CLI and the engine. */
export class Logger {
  private readonly sink: LogSink;
  private readonly level: DiagnosticLevel;
  private readonly prefix: string;
  private readonly silent: boolean;
  readonly diagnostics: Diagnostic[];

  constructor(options: LoggerOptions = {}) {
    this.sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
    this.level = options.level ?? 'info';
    this.prefix = options.prefix ?? '';
    this.silent = options.silent ?? false;
    this.diagnostics = options.diagnostics ?? [];
  }

  /** Create a child logger that records diagnostics into the parent as well. */
  child(prefix: string): Logger {
    const child = new Logger({
      sink: this.sink,
      level: this.level,
      prefix: this.prefix ? `${this.prefix}${prefix}` : prefix,
      silent: this.silent,
      diagnostics: this.diagnostics,
    });
    return child;
  }

  private shouldEmit(level: DiagnosticLevel): boolean {
    return !this.silent && LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  log(level: DiagnosticLevel, code: string, message: string, where?: string): void {
    this.diagnostics.push({ level, code, message, where });
    if (!this.shouldEmit(level)) return;
    const tags: Record<DiagnosticLevel, string> = { info: 'info', warn: 'warn', error: 'error' };
    const location = where ? ` ${where}` : '';
    this.sink(`${this.prefix}[${tags[level]}] ${message}${location}`);
  }

  info(message: string, code = 'info'): void {
    this.log('info', code, message);
  }

  warn(message: string, code = 'warn', where?: string): void {
    this.log('warn', code, message, where);
  }

  error(message: string, code = 'error', where?: string): void {
    this.log('error', code, message, where);
  }

  /** Raw write, bypassing level filtering. */
  write(line: string): void {
    if (this.silent) return;
    this.sink(line);
  }
}

/** A logger that discards everything. */
export const silentLogger = new Logger({ silent: true });
