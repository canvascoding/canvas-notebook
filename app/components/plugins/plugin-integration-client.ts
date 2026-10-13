'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import { safePluginReturnTo } from '@/app/lib/plugins/plugin-return';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { SharedConnectionRequestError, type SharedConnectionApi } from './shared-connections-client';

/** The established provider APIs have both shared-envelope and personal response shapes. */
export async function pluginIntegrationRequest<T>(path: string, workspaceId: string | null, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/api/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(path) || new URL(path, 'https://canvas.invalid').origin !== 'https://canvas.invalid' || !new URL(path, 'https://canvas.invalid').pathname.startsWith('/api/')) {
    throw new SharedConnectionRequestError(400, 'connection_path_invalid');
  }
  const headers = new Headers(init.headers);
  if (workspaceId) headers.set(WORKSPACE_ID_HEADER, workspaceId);
  const response = await fetch(path, {...init, headers, credentials: 'include', cache: 'no-store'});
  const body = await response.json();
  if (!response.ok || body.success === false) throw new SharedConnectionRequestError(response.status,
    typeof body.code === 'string' ? body.code : 'connection_unavailable');
  return (body.success === true && 'data' in body ? body.data : body) as T;
}

export function pluginSharedConnectionApi(workspaceId: string | null, isCurrent: () => boolean,
  onPending?: (pending: boolean) => void): SharedConnectionApi {
  let writes = 0;
  return async <T,>(path: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'): Promise<T> => {
    if (!isCurrent()) throw new DOMException('The connection context changed.', 'AbortError');
    const mutation = body !== undefined || method !== undefined;
    if (mutation) { writes += 1; onPending?.(true); }
    try {
      const result = await pluginIntegrationRequest<T>(path, workspaceId, {method: method ?? (body === undefined ? 'GET' : 'POST'),
        ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
      if (!isCurrent()) throw new DOMException('The connection context changed.', 'AbortError');
      return result;
    } finally { if (mutation) { writes -= 1; onPending?.(writes > 0); } }
  };
}

/** OAuth returns carry browsing context and one exact selection, never account/profile IDs. */
export function pluginCatalogReturnPath(path: string, locale: 'de' | 'en', workspaceId: string | null, selection: {extensionId?: string; resourceRef?: string}): string {
  const safe = safePluginReturnTo(path);
  if (!safe) throw new Error('Invalid plugin return path');
  const original = new URL(safe, 'https://canvas.invalid'), query = new URLSearchParams({view: 'browse'});
  for (const key of ['q', 'kind', 'stock', 'extensionSource', 'scope', 'teamId', 'audience']) {
    const value = original.searchParams.get(key); if (value) query.set(key, value);
  }
  if (workspaceId) query.set('workspaceId', workspaceId);
  if (selection.resourceRef) { query.set('resourceRef', selection.resourceRef); query.set('task', 'connections'); }
  else if (selection.extensionId) query.set('extensionId', selection.extensionId);
  else throw new Error('Missing exact plugin selection');
  return `/${locale}/plugins?${query}`;
}

/** The actor predicate is only evaluated by requests, never while React renders. */
export function usePluginSharedConnectionApi(workspaceId: string | null, isCurrent: () => boolean, onPending?: (pending: boolean) => void): SharedConnectionApi {
  const current = useRef<SharedConnectionApi | null>(null);
  useLayoutEffect(() => { current.current = pluginSharedConnectionApi(workspaceId, isCurrent, onPending); return () => { current.current = null; }; }, [workspaceId, isCurrent, onPending]);
  return useCallback(async <T,>(path: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'): Promise<T> => {
    if (!current.current) throw new DOMException('The connection context changed.', 'AbortError');
    return current.current<T>(path, body, method);
  }, []);
}
