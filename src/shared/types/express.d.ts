/**
 * What this application adds to an Express request.
 *
 * Every field here is written by middleware and only by middleware: a handler that wants validated
 * input, a tenant, or a correlation id reads it from here, and can therefore never read the raw,
 * untrusted value by accident.
 *
 * Express's own types are declared in a namespace, so augmenting them needs one too.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request, set by `requestId()`. Never sent to the client. */
      id?: string;
      /** The validated tenant, set by `workspaceScope()`. Never read from the header directly. */
      workspaceId: string;
      /** Set by `requireIdempotencyKey()`. Present only on the submission route. */
      idempotencyKey?: string;
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
