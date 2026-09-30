import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** The inbound header a proxy or client may use to supply its own correlation id. */
const REQUEST_ID_HEADER = 'X-Request-Id';

/** A supplied id is echoed in logs, so it is bounded before it can bloat every line. */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Gives every request a correlation id for logging.
 *
 * Deliberately does not set a response header. Adding one would change what every existing
 * endpoint returns, and this refactor is not allowed to change a single byte a client can see —
 * the id exists to tie log lines together, which needs no cooperation from the client.
 */
export function requestId(): RequestHandler {
  return function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const supplied = req.header(REQUEST_ID_HEADER);
    req.id = supplied && supplied.length <= MAX_REQUEST_ID_LENGTH ? supplied : randomUUID();
    next();
  };
}
