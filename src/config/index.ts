/**
 * The configuration layer's front door.
 *
 * `src/config` is the only place in the application that reads `process.env`. Everything else
 * imports from here, so "where does this setting come from?" has exactly one answer, and a new
 * tunable cannot be introduced by a call site quietly reaching for the environment.
 */
export {
  connectionLimitOf,
  getConfig,
  loadConfig,
  readLogLevel,
  readPrismaLogMode,
  resetConfigCache,
} from './env';
export type { Config, EnvSource, LogLevel, PrismaLogMode } from './env';
