/**
 * Opaque keyset cursors.
 *
 * Base64url of a private JSON shape. Opaque on purpose: a caller who can read the cursor starts
 * treating it as an API and pins us to this key forever. It is not a secret — it carries nothing
 * the caller did not already see in the page it came from.
 */
export function encodeCursor(cursor: object): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/**
 * Decodes a cursor and hands it to `isValid` before returning it.
 *
 * Returns `null` for anything that does not decode or does not pass the guard, so the caller
 * decides what a bad cursor means. It always means an error here, never a silent restart from the
 * first page — a caller mid-walk would otherwise loop forever with nothing to act on.
 */
export function decodeCursor<T>(raw: string, isValid: (value: unknown) => value is T): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  return isValid(parsed) ? parsed : null;
}
