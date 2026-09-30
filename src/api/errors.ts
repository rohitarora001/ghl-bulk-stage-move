import { BadRequestError, ConflictError, NotFoundError } from '@shared/errors';

/**
 * Compatibility shim for the pre-refactor error type.
 *
 * The three factories return the `@shared/errors` classes, so status, code, message and details
 * reach the caller exactly as before while call sites move module by module. This file is deleted
 * with the last one.
 *
 * @deprecated Throw `BadRequestError`, `NotFoundError` or `ConflictError` from `@shared/errors`.
 */
export const ApiError = {
  badRequest: (code: string, message: string, details?: unknown): BadRequestError =>
    new BadRequestError(code, message, details),

  notFound: (code: string, message: string): NotFoundError => new NotFoundError(code, message),

  conflict: (code: string, message: string, details?: unknown): ConflictError =>
    new ConflictError(code, message, details),
};
