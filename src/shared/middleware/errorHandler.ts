import type { NextFunction, Request, Response } from 'express';
import { AppError, ERROR_CODE } from '@shared/errors';
import { logger } from '@shared/logger';

/** The response envelope. Every error this API answers with has exactly this shape. */
interface ErrorResponseBody {
  error: { code: string; message: string; details?: unknown };
}

function body(code: string, message: string, details?: unknown): ErrorResponseBody {
  return { error: { code, message, details } };
}

interface BodyParserError {
  type?: string;
  status?: number;
  body?: unknown;
}

/**
 * The only place an error becomes an HTTP response.
 *
 * Services and repositories throw; nothing below this line writes a status code. That is what
 * keeps business rules free of `res` and what makes the error contract auditable in one file.
 */
export function errorHandler() {
  return function errorHandlerMiddleware(
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    if (error instanceof AppError) {
      res.status(error.statusCode).json(body(error.code, error.message, error.details));
      return;
    }

    // `express.json` rejects before any route runs, so its two failures can only be classified
    // here. Both are the caller's, and answering 500 tells them the server is broken when the fix
    // is theirs — while logging every malformed body at ERROR level buries real incidents.
    const bodyParser = error as BodyParserError;
    if (error instanceof SyntaxError && bodyParser.body !== undefined) {
      res.status(400).json(body(ERROR_CODE.INVALID_JSON, 'request body is not valid JSON'));
      return;
    }
    if (bodyParser.type === 'entity.too.large') {
      res.status(413).json(body(ERROR_CODE.PAYLOAD_TOO_LARGE, 'request body exceeds 1mb'));
      return;
    }

    // An unplanned error's message is as likely to leak internals as to help the caller, so it is
    // logged in full and answered with nothing.
    logger.error('unhandled_request_error', { error: String(error) });
    res.status(500).json(body(ERROR_CODE.INTERNAL_ERROR, 'internal error'));
  };
}
