import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ProviderRequest, ProviderResponse } from '../core/types.js';
import { hashObject } from '../utils/hash.js';
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';

export interface CacheOptions {
  enabled?: boolean;
  dir?: string;
  cwd?: string;
}

export class ResultCache {
  readonly enabled: boolean;
  readonly dir: string;

  constructor(options: CacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    const cwd = options.cwd ?? process.cwd();
    const rawDir = options.dir ?? '.prompt-guard/cache';
    this.dir = path.isAbsolute(rawDir) ? rawDir : path.join(cwd, rawDir);
  }

  computeKey(providerKind: string, request: ProviderRequest): string {
    return hashObject({
      providerKind,
      model: request.model ?? 'default',
      system: request.system ?? '',
      prompt: request.prompt,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? null,
      maxTokens: request.maxTokens ?? null,
    });
  }

  private entryPath(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<ProviderResponse | undefined> {
    if (!this.enabled) return undefined;
    const file = this.entryPath(key);
    try {
      if (!(await pathExists(file))) return undefined;
      const cached = await readJsonFile<ProviderResponse>(file);
      return cached;
    } catch {
      return undefined;
    }
  }

  async set(key: string, response: ProviderResponse): Promise<void> {
    if (!this.enabled) return;
    const file = this.entryPath(key);
    try {
      await ensureDir(this.dir);
      await writeJsonFile(file, response, false);
    } catch {
      // Caching failures should not abort test execution
    }
  }

  async clear(): Promise<number> {
    try {
      if (!(await pathExists(this.dir))) return 0;
      const entries = await fs.readdir(this.dir);
      let count = 0;
      for (const entry of entries) {
        if (entry.endsWith('.json')) {
          await fs.unlink(path.join(this.dir, entry)).catch(() => {});
          count += 1;
        }
      }
      return count;
    } catch {
      return 0;
    }
  }
}
