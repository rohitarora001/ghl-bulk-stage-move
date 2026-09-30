import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { logger } from '../shared/logger';
import { ApiError } from './errors';
import { workspaceScope } from './middleware/workspaceScope';
import { jobsRouter } from './routes/jobs';

/**
 * Builds the app without binding a port, so tests drive it in-process through supertest and the
 * suite never depends on a free port or on teardown ordering.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(workspaceScope());
  app.use(jobsRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'no such route' } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    // An unplanned error's message is as likely to leak internals as to help the caller, so it is
    // logged in full and answered with nothing.
    logger.error('unhandled_request_error', { error: String(error) });
    res.status(500).json({ error: { code: 'internal_error', message: 'internal error' } });
  });

  return app;
}
