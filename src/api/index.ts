import { getConfig } from '@config';
import { disconnectAll } from '@shared/database';
import { logger } from '@shared/logger';
import { createApp } from './server';

const server = createApp().listen(getConfig().port, () => {
  logger.info('api_listening', { port: getConfig().port });
});

/**
 * In-flight requests finish before the process exits; a container stop mid-submission would
 * otherwise leave a `jobs` row whose snapshot transaction never committed.
 */
function shutdown(signal: string): void {
  logger.info('api_shutdown', { signal });
  server.close(() => {
    void disconnectAll().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
