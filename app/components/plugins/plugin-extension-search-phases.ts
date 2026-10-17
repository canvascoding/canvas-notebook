import type { PluginExtensionSearchResponse } from '@/app/lib/plugins/plugin-extension-contracts';

export type ExtensionSearchPhase = 'local' | 'remote' | 'all';
export type ExtensionSearchPhaseRequest = { phase: ExtensionSearchPhase; cursor?: string };

/** Each server cursor retains its actual phase; the envelope is presentation state, never authority. */
export function pluginExtensionSearchPhaseRequests(cursor?: string): ExtensionSearchPhaseRequest[] {
  if (!cursor) return [{ phase: 'local' }, { phase: 'remote' }];
  try {
    const value = JSON.parse(atob(cursor.replace(/-/gu, '+').replace(/_/gu, '/')));
    if (value.v === 'extension-search-phases-1' && Object.keys(value).sort().join(',') === 'local,remote,v'
      && [value.local, value.remote].every(part => part === null || typeof part === 'string' && /^[A-Za-z0-9_-]{1,8192}$/u.test(part))) {
      return (['local', 'remote'] as const).flatMap(phase => value[phase] ? [{ phase, cursor: value[phase] }] : []);
    }
  } catch { /* Historical single-response cursors still go to their original complete search. */ }
  return [{ phase: 'all', cursor }];
}

export function pluginExtensionSearchPhaseCursor(responses: ReadonlyMap<ExtensionSearchPhase, PluginExtensionSearchResponse>): string | null {
  if (responses.has('all')) return responses.get('all')!.pagination.nextCursor;
  const local = responses.get('local')?.pagination.nextCursor ?? null;
  const remote = responses.get('remote')?.pagination.nextCursor ?? null;
  if (!local && !remote) return null;
  return btoa(JSON.stringify({ v: 'extension-search-phases-1', local, remote })).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
