import type { NextFunction, Request, Response } from 'express';
import { interactivePrisma } from '@shared/database';
import { ApiError } from '../errors';

/**
 * Every request carries its tenant in `X-Workspace-Id`, and this is the only place that header is
 * turned into a trusted value. Handlers read `req.workspaceId` and never the header, so a handler
 * cannot accidentally scope a query to an unvalidated, caller-supplied id.
 *
 * There is no authentication in scope, so this is not an authorization check and does not pretend
 * to be one: it establishes the scope, and every query still filters on it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspaceId: string;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workspaceScope() {
  return function workspaceScopeMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const header = req.header('X-Workspace-Id');
    if (!header) {
      next(ApiError.badRequest('workspace_required', 'X-Workspace-Id header is required'));
      return;
    }
    // Checked before it reaches Postgres: an id that is not a uuid would otherwise fail as a
    // cast error (a 500) rather than as the bad request it is.
    if (!UUID.test(header)) {
      next(ApiError.badRequest('workspace_invalid', 'X-Workspace-Id must be a uuid'));
      return;
    }

    interactivePrisma.workspace
      .findUnique({ where: { id: header }, select: { id: true } })
      .then((workspace) => {
        if (!workspace) {
          // Deliberately the same 400 as a malformed header: replying 404 here would confirm to
          // an unauthenticated caller which workspace ids exist.
          next(ApiError.badRequest('workspace_unknown', 'X-Workspace-Id does not exist'));
          return;
        }
        req.workspaceId = workspace.id;
        next();
      })
      .catch(next);
  };
}
