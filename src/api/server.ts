import express, { type Express } from 'express';
import { errorHandler, notFound, requestId } from '@shared/middleware';
import { workspaceScope } from './middleware/workspaceScope';
import { jobsRouter } from './routes/jobs';
import { opportunitiesRouter } from './routes/opportunities';

/** Bodies past this are rejected by the parser and answered 413 by the error handler. */
const MAX_BODY_SIZE = '1mb';

/**
 * Builds the app without binding a port, so tests drive it in-process through supertest and the
 * suite never depends on a free port or on teardown ordering.
 *
 * The order below is the contract: correlation id first so every later line can carry it, parsing
 * before anything reads a body, tenant scope before any route, and the two terminal handlers last.
 */
export function createApp(): Express {
  const app = express();

  app.use(requestId());
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(workspaceScope());
  app.use(jobsRouter());
  app.use(opportunitiesRouter());

  app.use(notFound());
  app.use(errorHandler());

  return app;
}
