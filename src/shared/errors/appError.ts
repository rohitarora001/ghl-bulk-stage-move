/**
 * The one error type the application throws on purpose.
 *
 * `isOperational` is the distinction that matters at the edge: an operational error is a situation
 * the code anticipated and can describe to the caller, so its message is safe to send. Anything
 * else is a bug, and a bug's message is as likely to leak internals as to help — the error handler
 * logs those in full and answers with nothing.
 */
export class AppError extends Error {
  readonly isOperational = true;

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — the request itself is wrong: shape, type, range, or a rule about its own fields. */
export class BadRequestError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(400, code, message, details);
  }
}

/** 401 — no identity was presented. Unused today; there is no authentication in scope. */
export class UnauthorizedError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(401, code, message, details);
  }
}

/** 403 — an identity was presented and is not allowed to do this. */
export class ForbiddenError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(403, code, message, details);
  }
}

/**
 * 404 — no such row in this workspace.
 *
 * Note what this deliberately does not distinguish: a row that does not exist and a row that
 * belongs to another tenant answer identically, so the response cannot be used to probe for the
 * existence of other tenants' data.
 */
export class NotFoundError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(404, code, message, details);
  }
}

/** 409 — the request is well formed but the current state refuses it. */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

/** 413 — the body is past the configured limit. */
export class PayloadTooLargeError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(413, code, message, details);
  }
}
