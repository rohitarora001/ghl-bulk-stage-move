import { createHash } from 'node:crypto';

/**
 * Recursively sorts object keys and drops `undefined` members.
 *
 * Key order is not part of a request, so two clients serialising the same payload differently must
 * not hash differently. `undefined` disappearing is wanted too: an absent optional field and an
 * explicitly-undefined one are the same query.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, member]) => [key, canonicalize(member)]),
    );
  }
  return value;
}

/** A stable SHA-256 of a request payload, insensitive to key order. */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}
