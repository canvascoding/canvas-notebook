import { QueryClient } from '@tanstack/react-query';
import {
  openedDocumentAuthScope,
  subscribeOpenedDocumentAuthInvalidation,
} from '@/app/lib/collaboration/opened-document-registry';

function createClient() {
  return new QueryClient({ defaultOptions: { queries: {
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }, mutations: { retry: false } } });
}

let browserClient: QueryClient | undefined;
let partition: string | undefined;
let anonymousEpoch = 0;

function authPartition() {
  const scope = openedDocumentAuthScope();
  return scope ? JSON.stringify([scope.userId, scope.sessionId, scope.epoch]) : `unresolved:${anonymousEpoch}`;
}

export function getNotebookQueryClient(): QueryClient {
  // Never share authenticated server-rendering data between requests.
  if (typeof window === 'undefined') return createClient();
  if (!browserClient) {
    browserClient = createClient();
    subscribeOpenedDocumentAuthInvalidation(() => {
      anonymousEpoch += 1;
      partition = undefined;
      browserClient?.clear();
    });
  }
  const nextPartition = authPartition();
  if (partition !== nextPartition) {
    // Initial session hydration is not an account change: allow reads already
    // started by authenticated pages to finish. Their unresolved keys are never
    // reused by the authenticated partition. Real auth changes clear immediately.
    if (!partition?.startsWith('unresolved:')) browserClient.clear();
    partition = nextPartition;
  }
  return browserClient;
}

export function notebookQueryKey(workspaceId: string | null, ...resource: readonly unknown[]) {
  return ['notebook', authPartition(), workspaceId, ...resource] as const;
}

/** A caller may leave without cancelling a shared read needed by another panel. */
export function withQueryConsumerSignal<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function fetchNotebookQuery<T>(options: {
  workspaceId: string | null;
  resource: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<T>;
  staleTime?: number;
  signal?: AbortSignal;
}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'));
  const client = getNotebookQueryClient();
  const queryKey = notebookQueryKey(options.workspaceId, ...options.resource);
  const request = client.fetchQuery({
    queryKey,
    queryFn: options.queryFn,
    // Before auth hydration reads can be shared in flight, but not reused later.
    staleTime: openedDocumentAuthScope() ? options.staleTime ?? 15_000 : 0,
  });
  return withQueryConsumerSignal(request, options.signal);
}

export function invalidateNotebookQueries(workspaceId: string | null, ...resource: readonly unknown[]) {
  return getNotebookQueryClient().invalidateQueries({ queryKey: notebookQueryKey(workspaceId, ...resource) });
}
