type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdFromEnv(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return ORDER[raw as Level] ?? ORDER.info;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < thresholdFromEnv()) return;
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
