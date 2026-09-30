import express, { type Express } from 'express';
import { bulkMoveRoutes } from '@modules/bulk-move/bulk-move.routes';
import { opportunitiesRoutes } from '@modules/opportunities/opportunities.routes';
import { errorHandler, notFound, requestId, workspaceScope } from '@shared/middleware';
import { container, type Container } from './container';

/** Bodies past this are rejected by the parser and answered 413 by the error handler. */
const MAX_BODY_SIZE = '1mb';

/**
 * Builds the app without binding a port, so tests drive it in-process through supertest and the
 * suite never depends on a free port or on teardown ordering.
 *
 * The order below is the contract: correlation id first so every later line can carry it, parsing
 * before anything reads a body, tenant scope before any route, and the two terminal handlers last.
 * `/health` sits above the scope on purpose — a liveness probe has no tenant.
 */
export function createApp(dependencies: Container = container): Express {
  const app = express();

  app.use(requestId());
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(
    workspaceScope({
      workspaceExists: (workspaceId) => dependencies.workspacesRepository.exists(workspaceId),
    }),
  );
  app.use(bulkMoveRoutes(dependencies.bulkMoveController));
  app.use(opportunitiesRoutes(dependencies.opportunitiesController));

  app.use(notFound());
  app.use(errorHandler());

  return app;
}
