/**
 * Abort-aware sleep.
 *
 * A plain `setTimeout` would make SIGTERM wait out the full backoff before the loop noticed it,
 * which is the difference between a container stopping and a container being killed.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
