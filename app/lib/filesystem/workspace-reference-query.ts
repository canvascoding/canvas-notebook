import { createHash } from 'node:crypto';
import { searchFileReferenceEntries, sortFileReferenceEntries,
  type FileReferenceEntry, type FileReferenceSortKey } from './file-reference-search';

export class WorkspaceReferenceQueryError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'INVALID_FILE_SEARCH') {
    super(message);
  }
}

export interface WorkspaceReferenceQuery {
  query: string;
  entryType: 'file' | 'directory' | 'all';
  extensions: string[];
  sort?: FileReferenceSortKey;
  limit: number;
  cursor: string | null;
}

export function parseWorkspaceReferenceQuery(params: URLSearchParams): WorkspaceReferenceQuery {
  const entryType = params.get('type') || 'file';
  if (entryType !== 'file' && entryType !== 'directory' && entryType !== 'all') {
    throw new WorkspaceReferenceQueryError('type must be file, directory, or all');
  }
  const sort = params.get('sort') || undefined;
  if (sort && !['name', 'created', 'modified', 'size'].includes(sort)) {
    throw new WorkspaceReferenceQueryError('sort must be name, created, modified, or size');
  }
  const rawLimit = params.get('limit') || '50';
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new WorkspaceReferenceQueryError('limit must be between 1 and 500');
  }
  const rawExtensions = params.get('extensions');
  const extensions = rawExtensions ? [...new Set(rawExtensions.toLowerCase().split(','))].sort() : [];
  if (extensions.length > 40 || extensions.some((extension) => !/^[a-z0-9]{1,16}$/.test(extension))) {
    throw new WorkspaceReferenceQueryError('extensions must be a comma-separated list of file extensions');
  }
  if (entryType === 'directory' && extensions.length) {
    throw new WorkspaceReferenceQueryError('Directory searches cannot filter file extensions');
  }
  return { query: (params.get('q') || '').trim().toLowerCase().slice(0, 256),
    entryType, extensions, sort: sort as FileReferenceSortKey | undefined, limit, cursor: params.get('cursor') };
}

export function selectWorkspaceReferencePage(entries: FileReferenceEntry[], query: WorkspaceReferenceQuery, workspaceId: string) {
  const eligible = entries.filter((entry) => (query.entryType === 'all' || entry.type === query.entryType)
    && (!query.extensions.length || entry.type === 'file' && query.extensions.includes(entry.extension || '')))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const matches = searchFileReferenceEntries(eligible, query.query);
  const sorted = query.sort ? sortFileReferenceEntries(matches, query.sort) : matches;
  const signature = createHash('sha256').update(JSON.stringify({ workspaceId,
    query: query.query, type: query.entryType, extensions: query.extensions, sort: query.sort || null,
    entries: sorted.map((entry) => [entry.path, entry.type, entry.size, entry.modified, entry.created]) })).digest('hex');
  let offset = 0;
  if (query.cursor !== null) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(query.cursor)) throw new WorkspaceReferenceQueryError('Invalid search cursor');
    let cursor: { offset?: unknown; signature?: unknown };
    try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')); }
    catch { throw new WorkspaceReferenceQueryError('Invalid search cursor'); }
    if (!cursor || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0) {
      throw new WorkspaceReferenceQueryError('Invalid search cursor');
    }
    if (cursor.signature !== signature) {
      throw new WorkspaceReferenceQueryError('Search results changed. Refresh the search.', 409, 'FILE_SEARCH_CHANGED');
    }
    if (Number(cursor.offset) > sorted.length) throw new WorkspaceReferenceQueryError('Invalid search cursor');
    offset = Number(cursor.offset);
  }
  const files = sorted.slice(offset, offset + query.limit);
  const nextOffset = offset + files.length;
  return { files, total: sorted.length, nextCursor: nextOffset < sorted.length
    ? Buffer.from(JSON.stringify({ offset: nextOffset, signature })).toString('base64url') : null };
}
