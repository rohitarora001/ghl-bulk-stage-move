import type { Request, RequestHandler, Response } from 'express';
import { ERROR_CODE } from '@shared/errors';

/**
 * The catch-all for a path no router matched.
 *
 * It answers directly rather than throwing a `NotFoundError`, which keeps "no such route" visibly
 * distinct from "no such row in this workspace" — the same status code, two unrelated causes.
 */
export function notFound(): RequestHandler {
  return function notFoundMiddleware(_req: Request, res: Response): void {
    res.status(404).json({ error: { code: ERROR_CODE.NOT_FOUND, message: 'no such route' } });
  };
}
