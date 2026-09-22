import type {
  FileVersionCenterRequestV1,
  FileVersionCompareRequestV1,
  FileVersionTimelineRequestV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { fetchNotebookQuery, getNotebookQueryClient, notebookQueryKey } from './client';

export type FileVersionCompareQueryOptions = {
  proposalVersion?: string | null;
  lineageId?: string;
  force?: boolean;
};

/** Live resolution and timeline pages only share work already in flight. */
export function fetchReviewResolution<T>(input: {
  request: FileVersionCenterRequestV1;
  readiness: 'once' | readonly number[];
  signal?: AbortSignal;
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
}) {
  return fetchNotebookQuery({
    workspaceId: input.request.target.workspaceId,
    resource: ['review', 'resolve', input.request, input.readiness],
    staleTime: 0, signal: input.signal, queryFn: input.queryFn,
  });
}

export function fetchReviewTimeline<T>(input: {
  request: FileVersionTimelineRequestV1;
  signal?: AbortSignal;
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
}) {
  return fetchNotebookQuery({
    workspaceId: input.request.target.workspaceId,
    resource: ['review', 'timeline', input.request],
    staleTime: 0, signal: input.signal, queryFn: input.queryFn,
  });
}

export function reviewComparisonResource(request: FileVersionCompareRequestV1, options: FileVersionCompareQueryOptions = {}) {
  return ['review', 'compare', request, options.lineageId ?? null, options.proposalVersion ?? null] as const;
}

export function fetchReviewComparison<T>(input: {
  request: FileVersionCompareRequestV1;
  signal?: AbortSignal;
  options?: FileVersionCompareQueryOptions;
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
}) {
  const options = input.options ?? {};
  const versioned = input.request.candidate.kind === 'revision' || typeof options.proposalVersion === 'string';
  return fetchNotebookQuery({
    workspaceId: input.request.target.workspaceId,
    resource: reviewComparisonResource(input.request, options),
    staleTime: versioned && !options.force ? 30_000 : 0,
    signal: input.signal, queryFn: input.queryFn,
  });
}

/** Capture authScope when starting a mutation: its response may arrive after logout. */
export async function invalidateReviewQueries(workspaceId: string, authScope = notebookQueryKey(workspaceId)[1]) {
  const client = getNotebookQueryClient();
  const predicate = ({ queryKey }: { queryKey: readonly unknown[] }) => (
    queryKey[0] === 'notebook' && queryKey[1] === authScope
    && queryKey[2] === workspaceId && queryKey[3] === 'review'
  );
  // An older in-flight snapshot must not refill the cache after a confirmed mutation.
  await client.cancelQueries({ predicate });
  await client.invalidateQueries({ predicate });
}
