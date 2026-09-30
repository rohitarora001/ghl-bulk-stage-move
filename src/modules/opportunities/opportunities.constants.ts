/** Largest page a caller may ask for. An unbounded `limit` is an unbounded response. */
export const MAX_PAGE_SIZE = 200;

/** Page size when the caller names none. */
export const DEFAULT_PAGE_SIZE = 50;

/** The four states an opportunity can be in. Mirrors the `opportunity_status` Postgres enum. */
export const OPPORTUNITY_STATUS = ['open', 'won', 'lost', 'abandoned'] as const;
