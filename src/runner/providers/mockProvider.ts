import { createHash } from 'node:crypto';
import type {
  MockProviderConfig,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from '../../core/types.js';
import { ProviderError } from '../../core/errors.js';
import { delay } from '../../utils/async.js';

const VOCAB = [
  'summary', 'request', 'response', 'policy', 'refund', 'order', 'account',
  'support', 'ticket', 'agent', 'customer', 'service', 'resolution', 'issue',
  'escalate', 'confirm', 'verify', 'steps', 'details', 'review', 'approve',
  'declined', 'pending', 'reviewing', 'contact', 'team', 'manager', 'plan',
  'upgrade', 'billing', 'invoice', 'payment', 'cancel', 'renew', 'eligible',
  'thanks', 'sorry', 'please', 'help', 'notice', 'important', 'required',
  'documentation', 'reason', 'example', 'result', 'note', 'warning', 'error',
];

function hashInt(input: string): number {
  const digest = createHash('sha256').update(input, 'utf8').digest();
  return digest.readUInt32BE(0);
}

/**
 * Build a deterministic pseudo-response from the prompt.
 *
 * The same prompt always produces the same output, which makes the mock
 * provider usable as a stable regression baseline in CI.
 */
export function deterministicResponse(prompt: string, seed = '', sentences = 3): string {
  const digest = hashInt(`${seed}::${prompt}`);
  const parts: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    const offset = hashInt(`${digest}:${i}`);
    const first = VOCAB[offset % VOCAB.length] as string;
    const second = VOCAB[(offset >>> 8) % VOCAB.length] as string;
    const third = VOCAB[(offset >>> 16) % VOCAB.length] as string;
    const count = 1 + (offset % 3);
    parts.push(`${first} ${second} ${third}`.split(' ').slice(0, count).join(' '));
  }
  const id = createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 8);
  return `${parts.join('. ')}. (ref:${id})`;
}

export interface MockProviderOptions {
  mock?: MockProviderConfig;
  model?: string;
  /** Overrides the reported provider kind. */
  kind?: 'mock' | 'echo';
}

export class MockProvider implements Provider {
  readonly kind: 'mock' | 'echo';
  readonly model?: string;
  private readonly mock: MockProviderConfig;

  constructor(options: MockProviderOptions = {}) {
    this.mock = options.mock ?? { mode: 'hash' };
    this.model = options.model;
    this.kind = options.kind ?? 'mock';
  }

  private findRule(request: ProviderRequest) {
    const rules = this.mock.rules ?? [];
    for (const rule of rules) {
      if (rule.fixtureId && rule.fixtureId === request.fixtureId) return rule;
      if (rule.match) {
        const flags = rule.caseInsensitive === false ? '' : 'i';
        try {
          if (new RegExp(rule.match, flags).test(request.prompt)) return rule;
        } catch {
          if (request.prompt.includes(rule.match)) return rule;
        }
      }
    }
    return undefined;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = performance.now();

    const simulated = this.mock.errors?.find((e) => e.fixtureId === request.fixtureId);
    if (simulated) {
      throw new ProviderError(simulated.message, simulated.status, {
        fixtureId: request.fixtureId,
      });
    }

    if (this.mock.latencyMs && this.mock.latencyMs > 0) {
      await delay(this.mock.latencyMs);
    }

    const mode = this.mock.mode ?? 'hash';
    let text: string;
    let raw: unknown;

    const rule = mode === 'rules' ? this.findRule(request) : undefined;
    if (request.mockResponse !== undefined) {
      text = request.mockResponse;
    } else if (rule) {
      if (rule.json !== undefined) {
        raw = rule.json;
        text = typeof rule.json === 'string' ? rule.json : JSON.stringify(rule.json, null, 2);
      } else {
        text = rule.response ?? '';
      }
    } else if (mode === 'echo') {
      text = request.prompt;
    } else if (mode === 'hash') {
      text = deterministicResponse(request.prompt, this.mock.seed ?? '');
    } else {
      text = this.mock.defaultResponse ?? deterministicResponse(request.prompt, this.mock.seed ?? '');
    }

    return {
      text,
      raw: raw ?? { text, mode },
      model: this.model,
      latencyMs: performance.now() - startedAt,
      metadata: { provider: 'mock', mode },
    };
  }
}
