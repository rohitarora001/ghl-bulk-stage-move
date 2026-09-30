import { readLogLevel, type LogLevel } from '@config';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[readLogLevel()]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  // stderr for warn/error so `docker compose up`'s combined output keeps them distinguishable.
  if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** JSON-lines logger. No dependency, no transports — the whole app logs to stdout/stderr. */
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};

export type Logger = typeof logger;

/**
 * A logger that stamps every line with the same context — a request id, a job id, a loop id.
 *
 * Correlation is the whole point: one bulk move writes thousands of lines across three loops and a
 * sweeper, and without a shared key on each line they cannot be told apart after the fact.
 */
export function withContext(context: Record<string, unknown>, base: Logger = logger): Logger {
  return {
    debug: (msg, meta) => base.debug(msg, { ...context, ...meta }),
    info: (msg, meta) => base.info(msg, { ...context, ...meta }),
    warn: (msg, meta) => base.warn(msg, { ...context, ...meta }),
    error: (msg, meta) => base.error(msg, { ...context, ...meta }),
  };
}
