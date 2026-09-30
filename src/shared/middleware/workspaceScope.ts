import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { BadRequestError, ERROR_CODE } from '@shared/errors';

/**
 * Every request carries its tenant in `X-Workspace-Id`, and this is the only place that header is
 * turned into a trusted value. Handlers read `req.workspaceId` and never the header, so a handler
 * cannot accidentally scope a query to an unvalidated, caller-supplied id.
 *
 * There is no authentication in scope, so this is not an authorization check and does not pretend
 * to be one: it establishes the scope, and every query still filters on it.
 *
 * The existence check is injected rather than imported. Middleware is a cross-cutting concern and
 * must not depend on a feature module — so the workspaces repository is handed in by the
 * composition root, and this file knows only that something can answer the question.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceScopeDependencies {
  workspaceExists(workspaceId: string): Promise<boolean>;
}

export function workspaceScope({ workspaceExists }: WorkspaceScopeDependencies): RequestHandler {
  return function workspaceScopeMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const header = req.header('X-Workspace-Id');
    if (!header) {
      next(new BadRequestError(ERROR_CODE.WORKSPACE_REQUIRED, 'X-Workspace-Id header is required'));
      return;
    }
    // Checked before it reaches Postgres: an id that is not a uuid would otherwise fail as a cast
    // error (a 500) rather than as the bad request it is.
    if (!UUID.test(header)) {
      next(new BadRequestError(ERROR_CODE.WORKSPACE_INVALID, 'X-Workspace-Id must be a uuid'));
      return;
    }

    workspaceExists(header)
      .then((exists) => {
        if (!exists) {
          // Deliberately the same 400 as a malformed header: replying 404 here would confirm to an
          // unauthenticated caller which workspace ids exist.
          next(new BadRequestError(ERROR_CODE.WORKSPACE_UNKNOWN, 'X-Workspace-Id does not exist'));
          return;
        }
        req.workspaceId = header;
        next();
      })
      .catch(next);
  };
}
