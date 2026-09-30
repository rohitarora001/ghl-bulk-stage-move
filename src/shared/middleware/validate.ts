import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { BadRequestError } from '@shared/errors';

/** Which part of the request a schema applies to. */
export type ValidationSource = 'body' | 'query' | 'params';

export interface ValidationOptions {
  /** The `error.code` to answer with. Each call site keeps the code it has always returned. */
  readonly code: string;
  /** The human-readable message. */
  readonly message: string;
  /** Whether zod's issue list is echoed in `error.details`. */
  readonly withDetails?: boolean;
}

/**
 * Validates one part of the request and parks the result on `req.validated`.
 *
 * Parking rather than overwriting is forced by Express 5, where `req.query` is a getter and
 * assigning to it throws. It is also the safer shape: the raw value stays visibly raw, so a
 * handler reading `req.body` instead of the validated copy is obvious in review.
 */
export function validate(
  schema: ZodType,
  source: ValidationSource,
  options: ValidationOptions,
): RequestHandler {
  return function validateMiddleware(req: Request, _res: Response, next: NextFunction): void {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const details = options.withDetails === false ? undefined : parsed.error.issues;
      next(new BadRequestError(options.code, options.message, details));
      return;
    }

    req.validated = { ...req.validated, [source]: parsed.data };
    next();
  };
}

/**
 * Reads what `validate()` stored.
 *
 * The cast is the one place this indirection costs something: Express's own types cannot carry a
 * per-route generic through a middleware chain. It is safe because the only writer is `validate`,
 * and it is confined to this function instead of repeated at every call site.
 */
export function validated<T>(req: Request, source: ValidationSource): T {
  return req.validated?.[source] as T;
}
