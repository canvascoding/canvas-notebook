import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export function createScopedShareRequester(input: {
  workspaceId: string;
  isCurrent: () => boolean;
  controllers: Set<AbortController>;
  fetcher?: typeof fetch;
}) {
  return async <T,>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> => {
    const controller = new AbortController();
    const assertCurrent = () => {
      if (!input.isCurrent() || controller.signal.aborted) throw new DOMException('Sharing context changed', 'AbortError');
    };
    assertCurrent();
    input.controllers.add(controller);
    try {
      const response = await (input.fetcher ?? fetch)(url, {
        method: options.method ?? 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { [WORKSPACE_ID_HEADER]: input.workspaceId, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const payload = await response.json();
      assertCurrent();
      if (!response.ok || payload.success === false) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload as T;
    } finally { input.controllers.delete(controller); }
  };
}
