import { logger } from '@shared/logger';
import { sleep } from './sleep';

/**
 * What one tick decided to do next. The processor owns the work; the loop owns the waiting.
 */
export interface TickResult {
  /** How long to sleep before the next tick. */
  readonly sleepMs: number;
}

export interface PollingLoopOptions {
  /** Named in every log line this loop writes. */
  readonly name: string;
  readonly signal: AbortSignal;
  /** One unit of work. Must not throw for anything recoverable. */
  readonly tick: () => Promise<TickResult>;
  /** How long to wait after a tick threw. */
  readonly errorBackoffMs: number;
  /** Extra fields for this loop's log lines — a loop id, a job kind. */
  readonly context?: Record<string, unknown>;
}

/**
 * Runs `tick` until the signal aborts. Returns only on abort, never on its own.
 *
 * Nothing a tick throws is allowed to end the loop. A dropped connection or a picker-level failure
 * is transient; a loop that exits on one silently shrinks the pool, and the work it would have
 * done simply stops happening with no error anywhere to show it.
 */
export async function runPollingLoop({
  name,
  signal,
  tick,
  errorBackoffMs,
  context = {},
}: PollingLoopOptions): Promise<void> {
  logger.info(`${name}_started`, context);

  while (!signal.aborted) {
    try {
      const { sleepMs } = await tick();
      await sleep(sleepMs, signal);
    } catch (error) {
      logger.error(`${name}_error`, { ...context, error: String(error) });
      await sleep(errorBackoffMs, signal);
    }
  }

  logger.info(`${name}_stopped`, context);
}
