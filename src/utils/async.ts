/**
 * Small concurrency helpers used by the regression engine.
 */

/** Run `tasks` with a bounded number of concurrent workers. */
export async function runPool<T, R>(
  tasks: Array<() => Promise<R>>,
  concurrency: number,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      if (!task) return;
      results[index] = await task();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** Reject after `ms` milliseconds. */
export function timeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message ?? `Operation timed out after ${ms}ms`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** True when the error looks like a transient provider failure. */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { status?: number; code?: string; name?: string; message?: string };
  if (typeof err.status === 'number') {
    return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
  }
  if (err.code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(err.code)) {
    return true;
  }
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const message = err.message ?? '';
  return /timeout|timed out|socket hang up|network|rate limit|too many requests|overloaded|503|502|504/i.test(
    message,
  );
}
