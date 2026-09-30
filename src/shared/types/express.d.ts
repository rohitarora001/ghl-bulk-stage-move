/**
 * What this application adds to an Express request.
 *
 * Both fields are written by middleware and only by middleware: a handler that wants validated
 * input or a correlation id reads it from here, and can therefore never read the raw, untrusted
 * value by accident.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request, set by `requestId()`. Never sent to the client. */
      id?: string;
      /** Inputs that passed their schema, set by `validate()`. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
