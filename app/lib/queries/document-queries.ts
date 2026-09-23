import type { CurrentFile, FileNode } from '@/app/lib/files/types';
import { fetchNotebookQuery } from './client';

type DocumentQueryScope = { workspaceId: string | null; path: string; noCache: boolean; signal?: AbortSignal };

/** Share concurrent reads; the file store and collaboration layer own visible snapshots. */
export function fetchDocumentQuery(input: DocumentQueryScope & { metaOnly: boolean },
  queryFn: (context: { signal: AbortSignal }) => Promise<CurrentFile>) {
  return fetchNotebookQuery({
    workspaceId: input.workspaceId,
    resource: ['document', 'read', input.path, input.metaOnly, input.noCache],
    staleTime: 0,
    signal: input.signal,
    queryFn,
  });
}

export function fetchDocumentTreeQuery(input: DocumentQueryScope & { depth: number; includeStats: boolean },
  queryFn: (context: { signal: AbortSignal }) => Promise<FileNode[]>) {
  return fetchNotebookQuery({
    workspaceId: input.workspaceId,
    resource: ['document', 'tree', input.path, input.depth, input.includeStats, input.noCache],
    staleTime: 0,
    signal: input.signal,
    queryFn,
  });
}
