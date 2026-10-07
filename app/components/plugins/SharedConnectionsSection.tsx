'use client';

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { authClient } from '@/app/lib/auth-client';
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
import { confirmPluginNavigation, usePluginEditorNavigationGuard } from './plugin-navigation-guard';

type SharedConnectionsProps = { workspaceId?: string | null; ownership?: CapabilityResourceOwnerScope; initiallyOpen?: boolean;
  initialConnectionRef?: string; returnStatus?: 'connected' | 'cancelled' | 'failed' };

export function SharedConnectionsSection(props: SharedConnectionsProps) {
  const { data: session, isPending, error } = authClient.useSession();
  const enabled = Boolean(session?.user.id && !isPending && !error);
  return <SharedConnectionsSession key={JSON.stringify([session?.user.id ?? null, session?.session.id ?? null, enabled,
    props.workspaceId ?? '', props.ownership ?? null, props.initialConnectionRef ?? null])} {...props} enabled={enabled} authError={Boolean(error)} actorId={session?.user.id ?? null} authSessionId={session?.session.id ?? null} />;
}

/** Scope changes own a separate mounted state, including pending reads and account selection. */
function SharedConnectionsSession({ workspaceId, ownership, initiallyOpen = false, initialConnectionRef, returnStatus,
  enabled, authError, actorId, authSessionId }: SharedConnectionsProps & { enabled: boolean; authError: boolean; actorId: string | null; authSessionId: string | null }) {
  const t = useTranslations('sharedConnections'), locale = useLocale();
  const [open, setOpen] = useState(initiallyOpen);
  const [connections, setConnections] = useState<IntegrationConnectionDescriptor[]>([]);
  const [scopes, setScopes] = useState<IntegrationConnectionScopeChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<IntegrationConnectionDescriptor | null>(null);
  const revision = useRef(0), alive = useRef(true);
  const initialAttempted = useRef(false), selectedRef = useRef<string | null>(null);
  const isCurrentSession = useCallback((connectionRef: string) => {
    const current = authClient.$store.atoms.session.get();
    return alive.current && enabled && !current.isPending && !current.error
      && current.data?.user.id === actorId && current.data?.session.id === authSessionId
      && selectedRef.current === connectionRef;
  }, [actorId, authSessionId, enabled]);
  const writes = useRef(0);
  const readPending = useCallback(() => writes.current > 0, []);
  usePluginEditorNavigationGuard({ dirty: false, pending: readPending });
  const api: SharedConnectionApi = useCallback(async <T,>(url: string, body?: unknown, method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE'): Promise<T> => {
    const mutation = method !== undefined || body !== undefined;
    if (mutation) writes.current += 1;
    try {
      const response = await fetch(url, { method: method ?? (body === undefined ? 'GET' : 'POST'), cache: 'no-store', credentials: 'include',
      headers: { ...(workspaceId ? { [WORKSPACE_ID_HEADER]: workspaceId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json() as { success: boolean; code?: string; data?: T };
    if (!response.ok || !payload.success || !payload.data) throw new SharedConnectionRequestError(response.status, payload.code || 'connection_unavailable');
      return payload.data;
    } finally {
      if (mutation) writes.current -= 1;
    }
  }, [workspaceId]);
  const matchesOwnership = useCallback((owner: CapabilityResourceOwnerScope) => !ownership || owner.type === ownership.type
    && (owner.type === 'organization' && ownership.type === 'organization' ? owner.organizationId === ownership.organizationId
      : owner.type === 'team' && ownership.type === 'team' ? owner.organizationId === ownership.organizationId && owner.workspaceId === ownership.workspaceId
        : owner.type === 'user' && ownership.type === 'user' ? owner.ownerUserId === ownership.ownerUserId : owner.type === 'system'), [ownership]);
  const load = useCallback(async () => {
    if (!enabled) return;
    const request = ++revision.current;
    const reopen = Boolean(initialConnectionRef && !initialAttempted.current);
    setLoading(true); setError(false);
    try {
      const [list, setup] = await Promise.all([
        api<{ connections: IntegrationConnectionDescriptor[] }>('/api/integrations/shared-connections'),
        api<{ scopes: IntegrationConnectionScopeChoice[] }>('/api/integrations/shared-connections/setup'),
      ]);
      if (!alive.current || request !== revision.current) return;
      if (reopen) {
        if (!workspaceId || workspaceId !== workspaceId.trim() || /[\\\u0000-\u001f\u007f]/u.test(workspaceId)
          || !/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(initialConnectionRef!)) throw new Error('invalid_connection_selection');
        const exact = (await api<{ connection: IntegrationConnectionDescriptor }>(`/api/integrations/shared-connections/${encodeURIComponent(initialConnectionRef!)}`)).connection;
        if (!alive.current || request !== revision.current) return;
        if (exact.resource.connectionRef !== initialConnectionRef || !matchesOwnership(exact.resource.ownership)) throw new Error('connection_selection_unavailable');
        initialAttempted.current = true; selectedRef.current = exact.resource.connectionRef; setSelected(exact);
      }
      setConnections(list.connections.filter(connection => matchesOwnership(connection.resource.ownership)));
      setScopes(setup.scopes.filter(scope => matchesOwnership(scope.ownership)));
    } catch { if (alive.current && request === revision.current) { if (reopen) initialAttempted.current = true; selectedRef.current = null; setSelected(null); setConnections([]); setScopes([]); setError(true); } }
    finally { if (alive.current && request === revision.current) setLoading(false); }
  }, [api, enabled, initialConnectionRef, matchesOwnership, workspaceId]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; selectedRef.current = null; revision.current += 1; }; }, []);
  useEffect(() => { if (initiallyOpen && enabled) startTransition(() => { void load(); }); }, [enabled, initiallyOpen, load]);
  const refresh = (retryReturn = false) => { if (retryReturn) initialAttempted.current = false; selectedRef.current = null; setSelected(null); setCreateOpen(false); void load(); };
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
          <Button variant="outline" size="sm" onClick={() => { if (writes.current === 0 && confirmPluginNavigation()) refresh(true); }} disabled={loading || !enabled}><RefreshCw className="mr-2 size-4" />{t('reload')}</Button>
          {scopes.length ? <Button size="sm" onClick={() => setCreateOpen(true)} disabled={loading} data-testid="shared-connection-create"><Plus className="mr-2 size-4" />{t('create')}</Button> : null}
        </div>
      </div>
      {!enabled && authError ? <InlineNotice variant="destructive" size="compact">{t('loadError')}</InlineNotice>
        : !enabled || loading ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />{t('loading')}</p>
        : error ? <InlineNotice variant="destructive" size="compact">{t('loadError')}</InlineNotice>
          : !connections.length ? <p className="py-3 text-sm text-muted-foreground">{t('empty')}</p>
            : <div className="divide-y rounded-lg border">{connections.map(connection => <button type="button" key={connection.resource.connectionRef}
              className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/30"
              onClick={() => { selectedRef.current = connection.resource.connectionRef; setSelected(connection); }} data-testid="shared-connection-row">
              <span className="min-w-0"><span className="block break-words text-sm font-medium">{connection.resource.displayName}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{scopeLabel(connection)} · {connection.resource.source === 'mcp' ? t('mcp') : t('composio')}</span></span>
              <Badge variant="outline">{connection.resource.status === 'archived' ? t('archived') : connection.access.canManage ? t('manage') : t('canUse')}</Badge>
            </button>)}</div>}
    </div> : null}
    <Dialog open={createOpen} onOpenChange={value => { if (!value && (writes.current > 0 || !confirmPluginNavigation())) return; setCreateOpen(value); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl" data-testid="shared-connection-create-dialog">
      <DialogHeader><DialogTitle>{t('createTitle')}</DialogTitle><DialogDescription>{t('createDescription')}</DialogDescription></DialogHeader>
      {createOpen ? <SharedConnectionCreateForm api={api} scopes={scopes} onSaved={refresh} /> : null}
    </DialogContent></Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={value => { if (!value && writes.current === 0 && confirmPluginNavigation()) { selectedRef.current = null; setSelected(null); } }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl" data-testid="shared-connection-edit-dialog">
      <DialogHeader><DialogTitle>{selected?.resource.displayName}</DialogTitle><DialogDescription>{selected ? scopeLabel(selected) : ''}</DialogDescription></DialogHeader>
      {selected ? <SharedConnectionEditor key={selected.resource.connectionRef} api={api} initial={selected} onSaved={refresh} workspaceId={workspaceId ?? null} isCurrentSession={isCurrentSession}
        returnLocale={workspaceId && (locale === 'de' || locale === 'en') ? locale : undefined}
        returnStatus={selected.resource.connectionRef === initialConnectionRef ? returnStatus : undefined} /> : null}
    </DialogContent></Dialog>
  </section>;
}
