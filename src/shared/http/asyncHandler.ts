import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 *
 * Express 5 forwards rejections from async handlers on its own, but only for handlers it knows are
 * async. Wrapping is still the rule here for one reason: it makes "every handler routes its errors
 * to one place" a property of the wiring rather than a habit each new handler has to remember.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return function wrappedHandler(req, res, next) {
    handler(req, res, next).catch(next);
  };
}
