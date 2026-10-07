'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import type { IntegrationConnectionDescriptor, IntegrationConnectionScopeChoice } from '@/app/lib/integration-tools/connections/contracts';
import type { CapabilityResourceOwnerScope } from '@/app/lib/capabilities/resources/contracts';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { SharedConnectionCreateForm, SharedConnectionEditor } from './SharedConnectionForms';
import { SharedConnectionRequestError, type SharedConnectionApi } from './shared-connections-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { usePluginEditorNavigationGuard } from './plugin-navigation-guard';

type SharedConnectionsProps = { workspaceId?: string | null; ownership?: CapabilityResourceOwnerScope; initiallyOpen?: boolean };

export function SharedConnectionsSection(props: SharedConnectionsProps) {
  return <SharedConnectionsSession key={JSON.stringify([props.workspaceId ?? '', props.ownership ?? null])} {...props} />;
}

/** Scope changes own a separate mounted state, including pending reads and account selection. */
function SharedConnectionsSession({ workspaceId, ownership, initiallyOpen = false }: SharedConnectionsProps) {
  const t = useTranslations('sharedConnections');
  const [open, setOpen] = useState(initiallyOpen);
  const [connections, setConnections] = useState<IntegrationConnectionDescriptor[]>([]);
  const [scopes, setScopes] = useState<IntegrationConnectionScopeChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<IntegrationConnectionDescriptor | null>(null);
  const revision = useRef(0), alive = useRef(true);
  const writes = useRef(0), [pending, setPending] = useState(false);
  usePluginEditorNavigationGuard({ dirty: false, pending });
  const api: SharedConnectionApi = useCallback(async <T,>(url: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'): Promise<T> => {
    const mutation = method !== undefined || body !== undefined;
    if (mutation) { writes.current += 1; setPending(true); }
    try {
      const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'), cache: 'no-store', credentials: 'include',
      headers: { ...(workspaceId ? { [WORKSPACE_ID_HEADER]: workspaceId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json() as { success: boolean; code?: string; data?: T };
    if (!response.ok || !payload.success || !payload.data) throw new SharedConnectionRequestError(response.status, payload.code || 'connection_unavailable');
      return payload.data;
    } finally {
      if (mutation) { writes.current -= 1; if (alive.current) setPending(writes.current > 0); }
    }
  }, [workspaceId]);
  const matchesOwnership = useCallback((owner: CapabilityResourceOwnerScope) => !ownership || owner.type === ownership.type
    && (owner.type === 'organization' && ownership.type === 'organization' ? owner.organizationId === ownership.organizationId
      : owner.type === 'team' && ownership.type === 'team' ? owner.organizationId === ownership.organizationId && owner.workspaceId === ownership.workspaceId
        : owner.type === 'user' && ownership.type === 'user' ? owner.ownerUserId === ownership.ownerUserId : owner.type === 'system'), [ownership]);
  const load = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true); setError(false);
    try {
      const [list, setup] = await Promise.all([
        api<{ connections: IntegrationConnectionDescriptor[] }>('/api/integrations/shared-connections'),
        api<{ scopes: IntegrationConnectionScopeChoice[] }>('/api/integrations/shared-connections/setup'),
      ]);
      if (!alive.current || request !== revision.current) return;
      setConnections(list.connections.filter(connection => matchesOwnership(connection.resource.ownership)));
      setScopes(setup.scopes.filter(scope => matchesOwnership(scope.ownership)));
    } catch { if (alive.current && request === revision.current) { setConnections([]); setScopes([]); setError(true); } }
    finally { if (alive.current && request === revision.current) setLoading(false); }
  }, [api, matchesOwnership]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current += 1; }; }, []);
  useEffect(() => { if (initiallyOpen) startTransition(() => { void load(); }); }, [initiallyOpen, load]);
  const refresh = () => { setSelected(null); setCreateOpen(false); void load(); };
  const scopeLabel = (value: IntegrationConnectionDescriptor) => value.resource.ownership.type === 'organization' ? t('organization')
    : `${t('team')} · ${value.ownershipLabel || scopes.find(scope => scope.ownership.type === 'team' && value.resource.ownership.type === 'team'
      && scope.ownership.workspaceId === value.resource.ownership.workspaceId)?.label || t('sharedTeam')}`;

  return <section className="mb-4 rounded-xl border bg-card" data-testid="shared-connections">
    <button type="button" className="flex w-full items-center justify-between gap-3 p-4 text-left" aria-expanded={open}
      onClick={() => { setOpen(value => !value); if (!open) void load(); }}>
      <span><span className="block text-sm font-semibold">{t('title')}</span><span className="mt-1 block text-xs text-muted-foreground">{t('description')}</span></span>
      <span aria-hidden="true" className="text-lg text-muted-foreground">{open ? '−' : '+'}</span>
    </button>
    {open ? <div className="space-y-3 border-t p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('separateAccountHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 size-4" />{t('reload')}</Button>
          {scopes.length ? <Button size="sm" onClick={() => setCreateOpen(true)} disabled={loading} data-testid="shared-connection-create"><Plus className="mr-2 size-4" />{t('create')}</Button> : null}
        </div>
      </div>
      {loading ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />{t('loading')}</p>
        : error ? <InlineNotice variant="destructive" size="compact">{t('loadError')}</InlineNotice>
          : !connections.length ? <p className="py-3 text-sm text-muted-foreground">{t('empty')}</p>
            : <div className="divide-y rounded-lg border">{connections.map(connection => <button type="button" key={connection.resource.connectionRef}
              className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/30"
              onClick={() => setSelected(connection)} data-testid="shared-connection-row">
              <span className="min-w-0"><span className="block break-words text-sm font-medium">{connection.resource.displayName}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{scopeLabel(connection)} · {connection.resource.source === 'mcp' ? t('mcp') : t('composio')}</span></span>
              <Badge variant="outline">{connection.resource.status === 'archived' ? t('archived') : connection.access.canManage ? t('manage') : t('canUse')}</Badge>
            </button>)}</div>}
    </div> : null}
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{t('createTitle')}</DialogTitle><DialogDescription>{t('createDescription')}</DialogDescription></DialogHeader>
      {createOpen ? <SharedConnectionCreateForm api={api} scopes={scopes} onSaved={refresh} /> : null}
    </DialogContent></Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={value => { if (!value) setSelected(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{selected?.resource.displayName}</DialogTitle><DialogDescription>{selected ? scopeLabel(selected) : ''}</DialogDescription></DialogHeader>
      {selected ? <SharedConnectionEditor key={selected.resource.connectionRef} api={api} initial={selected} onSaved={refresh} /> : null}
    </DialogContent></Dialog>
  </section>;
}
