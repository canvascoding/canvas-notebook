import { createHash } from 'node:crypto';

export class LegacyPaginationError extends Error {
  constructor(readonly code: 'INVALID_SEARCH_CURSOR' | 'SEARCH_CORPUS_CHANGED' | 'FILE_REVISION_CONFLICT', message: string) {
    super(message);
  }
}

export function legacySearchFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** A cursor is only a position, never authority. The caller reauthorizes and
 * reconstructs the visible candidate set before decoding it on every request. */
export function decodeLegacySearchCursor(value: string, scope: string, snapshot: string, count: number): { index: number; skipped: number } {
  if (!value) return { index: 0, skipped: 0 };
  let parsed;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(value)) throw new Error();
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || parsed.version !== 1 || parsed.scope !== scope
      || typeof parsed.snapshot !== 'string' || !/^[a-f0-9]{64}$/u.test(parsed.snapshot)
      || !Number.isSafeInteger(parsed.index) || parsed.index < 0 || parsed.index > count
      || !Number.isSafeInteger(parsed.skipped) || parsed.skipped < 0 || parsed.skipped > parsed.index) throw new Error();
  } catch {
    throw new LegacyPaginationError('INVALID_SEARCH_CURSOR', 'Use the exact legacy_cursor with the same workspace, query and path.');
  }
  if (parsed.snapshot !== snapshot) throw new LegacyPaginationError('SEARCH_CORPUS_CHANGED', 'Candidate paths or file metadata changed. Restart without legacy_cursor.');
  return { index: parsed.index, skipped: parsed.skipped };
}

export function encodeLegacySearchCursor(scope: string, snapshot: string, index: number, skipped: number): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, snapshot, index, skipped })).toString('base64url');
}
