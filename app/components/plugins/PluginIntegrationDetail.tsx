'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { authClient } from '@/app/lib/auth-client';
import type { PluginExtensionItem, PluginExtensionConnection, PluginExtensionSearchResponse } from '@/app/lib/plugins/plugin-extension-contracts';
import type { IntegrationConnectionDescriptor, IntegrationConnectionScopeChoice } from '@/app/lib/integration-tools/connections/contracts';
import { startMcpAuthorization, waitForMcpAuthorization, McpAuthorizationError } from '@/app/lib/desktop/mcp-oauth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SharedConnectionCreateForm, SharedConnectionEditor } from './SharedConnectionForms';
import { PluginMcpSetup } from './PluginMcpSetup';
import { pluginCatalogReturnPath, pluginIntegrationRequest, usePluginSharedConnectionApi } from './plugin-integration-client';
import { confirmPluginNavigation, usePluginEditorNavigationGuard } from './plugin-navigation-guard';

type IntegrationItem = Extract<PluginExtensionItem, {kind: 'integration' | 'mcp'}>;
export type PluginIntegrationDetailProps = {item: IntegrationItem; workspaceId: string | null; onUpdated: () => void; onClose: () => void; returnPath: string};
type Profile = {id: string; name: string; status: string};
type Profiles = {profiles: Profile[]; effectiveProfile: {id: string; name: string; workspaceId: string}; workspace: {id: string}};
const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
const shared = (value: PluginExtensionConnection) => value.ownership.type === 'organization' || value.ownership.type === 'team';

/** Selection metadata is refreshed for the current signed-in actor before setup actions appear. */
export function PluginIntegrationDetail(props: PluginIntegrationDetailProps) {
  const {data: session, isPending, error} = authClient.useSession();
  return <IntegrationDetailSession key={JSON.stringify([session?.user.id, session?.session.id, props.workspaceId, props.item.id])} {...props}
    actorId={session?.user.id ?? null} sessionId={session?.session.id ?? null} enabled={Boolean(session && !isPending && !error)} />;
}
function IntegrationDetailSession({item: initial, workspaceId, onUpdated, onClose, returnPath, actorId, sessionId, enabled}: PluginIntegrationDetailProps & {
  actorId: string | null; sessionId: string | null; enabled: boolean;
}) {
  const t = useTranslations('skills.workspace.setup'), rawLocale = useLocale(), locale = rawLocale === 'de' ? 'de' : 'en';
  const [item, setItem] = useState<IntegrationItem | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]), [personalAvailable, setPersonalAvailable] = useState(false);
  const profileCurrent = useRef(false);
  const [profiles, setProfiles] = useState<Profiles | null>(null), [profileId, setProfileId] = useState(''), [profileName, setProfileName] = useState('');
  const [connectionRef, setConnectionRef] = useState(''), [sharedConnection, setSharedConnection] = useState<IntegrationConnectionDescriptor | null>(null);
  const [scopes, setScopes] = useState<IntegrationConnectionScopeChoice[]>([]), [createShared, setCreateShared] = useState(false), [editMcp, setEditMcp] = useState(false), [canManageMcp, setCanManageMcp] = useState(false);
  const [mcpAuthRequired, setMcpAuthRequired] = useState(false), [sharedMcpAuthRequired, setSharedMcpAuthRequired] = useState(false);
  const [tools, setTools] = useState<Array<{name: string; description?: string}>>([]), [toolsLoading, setToolsLoading] = useState(false), [toolsError, setToolsError] = useState(false);
  const alive = useRef(false), generation = useRef(0), request = useRef<AbortController | null>(null), oauth = useRef<AbortController | null>(null), selectedRef = useRef(connectionRef);
  useLayoutEffect(() => { selectedRef.current = connectionRef; }, [connectionRef]);
  useLayoutEffect(() => { profileCurrent.current = Boolean(profiles && !loading && personalAvailable); }, [profiles, loading, personalAvailable]);
  const isCurrent = useCallback(() => { const current = authClient.$store.atoms.session.get(); return alive.current && enabled && !current.isPending && !current.error
    && current.data?.user.id === actorId && current.data?.session.id === sessionId; }, [actorId, sessionId, enabled]);
  const isCurrentShared = useCallback((ref: string) => isCurrent() && selectedRef.current === ref, [isCurrent]);
  const api = usePluginSharedConnectionApi(workspaceId, isCurrent, setPending);
  usePluginEditorNavigationGuard({dirty: profileName !== '', pending});
  const load = useCallback(async () => {
    if (!isCurrent()) return;
    request.current?.abort(); const controller = new AbortController(), current = ++generation.current; request.current = controller;
    profileCurrent.current = false;
    setLoading(true); setError(null); setSharedConnection(null); setProfiles(null); setProfileId(''); setScopes([]); setCanManageMcp(false); setMcpAuthRequired(false);
    setWarnings([]); setPersonalAvailable(false); setTools([]); setToolsError(false); setProfileName(''); setCreateShared(false);
    try {
      const query = new URLSearchParams({types: initial.kind, scope: 'all', limit: '1', selected: initial.id});
      const response = await pluginIntegrationRequest<PluginExtensionSearchResponse>(`/api/plugins/search?${query}`, workspaceId, {signal: controller.signal});
      if (!isCurrent() || current !== generation.current) return;
      const fresh = response.selectedItem;
      if (!fresh || fresh.id !== initial.id || fresh.kind !== initial.kind || !fresh.access.canRead || !('connections' in fresh)) throw new Error('access_changed');
      setItem(fresh);
      const coverage = response.coverage.find(value => value.source === (fresh.kind === 'integration' ? 'composio' : 'mcp'));
      const incomplete = !coverage || coverage.status !== 'complete', nextWarnings: string[] = incomplete ? ['partialCoverage'] : [];
      setPersonalAvailable(Boolean(coverage && (coverage.status === 'complete' || coverage.status === 'partial')));
      const oldRef = selectedRef.current, callbackRef = new URL(returnPath, 'https://canvas.invalid').searchParams.get('connectionRef');
      const nextRef = fresh.connections.some(value => value.connectionRef === oldRef) ? oldRef : fresh.connections.some(value => value.connectionRef === callbackRef) ? callbackRef!
        : fresh.connections.length === 1 ? fresh.connections[0].connectionRef : '';
      setConnectionRef(nextRef);
      const results = await Promise.allSettled([
        api<{scopes: IntegrationConnectionScopeChoice[]}>('/api/integrations/shared-connections/setup'),
        fresh.kind === 'integration' ? pluginIntegrationRequest<Profiles>('/api/composio/profiles', workspaceId, {signal: controller.signal})
          : Promise.all([pluginIntegrationRequest<{canManageDefinitions: boolean}>('/api/integrations/mcp-definitions', workspaceId, {signal: controller.signal}),
            fresh.mcp.serverId ? pluginIntegrationRequest<{oauth: Array<{serverName: string; configured: boolean; requiresAuth: boolean}>}>('/api/integrations/mcp-status', workspaceId, {signal: controller.signal}).catch(() => null) : Promise.resolve(null),
          ]).then(([definitions, status]) => ({...definitions, mcpAuthRequired: status?.oauth.some(value => value.serverName === fresh.name && value.configured && value.requiresAuth) === true, metadataUnavailable: Boolean(fresh.mcp.serverId && !status)})),
      ]);
      if (!isCurrent() || current !== generation.current) return;
      setScopes(results[0].status === 'fulfilled' ? results[0].value.scopes : []);
      if (results[0].status === 'rejected') nextWarnings.push('sharedSetupUnavailable');
      const provider = results[1];
      if (provider.status === 'rejected') nextWarnings.push(fresh.kind === 'integration' ? 'profilesUnavailable' : 'metadataUnavailable');
      if (provider.status === 'fulfilled' && fresh.kind === 'integration' && 'profiles' in provider.value) {
        const value = provider.value as Profiles; setProfiles(value); const selectedProfile = fresh.connections.find(connection => connection.connectionRef === nextRef)?.profileId;
        setProfileId(selectedProfile && value.profiles.some(profile => profile.id === selectedProfile && profile.status === 'active') ? selectedProfile : value.effectiveProfile.id);
      } else if (provider.status === 'fulfilled' && 'canManageDefinitions' in provider.value) { setCanManageMcp(provider.value.canManageDefinitions); setMcpAuthRequired(provider.value.mcpAuthRequired); if (provider.value.metadataUnavailable) nextWarnings.push('metadataUnavailable'); }
      setWarnings([...new Set(nextWarnings)]);
    } catch { if (isCurrent() && !controller.signal.aborted && current === generation.current) { setItem(null); setError(t('loadError')); } }
    finally { if (isCurrent() && current === generation.current) setLoading(false); }
  }, [api, initial.id, initial.kind, isCurrent, returnPath, t, workspaceId]);
  useEffect(() => { alive.current = true; queueMicrotask(() => void load()); return () => { alive.current = false; generation.current += 1; request.current?.abort(); oauth.current?.abort(); }; }, [load]);
  const chosen = item?.connections.find(value => value.connectionRef === connectionRef);
  useEffect(() => {
    queueMicrotask(() => { if (isCurrent()) { setSharedConnection(null); setSharedMcpAuthRequired(false); } });
    if (!chosen || !shared(chosen)) return;
    const controller = new AbortController();
    void pluginIntegrationRequest<{connection: IntegrationConnectionDescriptor}>(`/api/integrations/shared-connections/${encodeURIComponent(chosen.connectionRef)}`, workspaceId, {signal: controller.signal})
      .then(value => { if (isCurrent() && !controller.signal.aborted && selectedRef.current === chosen.connectionRef && value.connection.resource.connectionRef === chosen.connectionRef) {
          setSharedConnection(value.connection);
          if (value.connection.resource.source === 'mcp') {
            void pluginIntegrationRequest<{configured: boolean; requiresAuth: boolean}>(`/api/mcp/shared-connections/${encodeURIComponent(chosen.connectionRef)}/oauth`, workspaceId, {signal: controller.signal})
              .then(status => { if (isCurrent() && !controller.signal.aborted && selectedRef.current === chosen.connectionRef) setSharedMcpAuthRequired(status.configured && status.requiresAuth); })
              .catch(() => { if (isCurrent() && !controller.signal.aborted) setError(t('loadError')); });
          }
        } })
      .catch(() => { if (isCurrent() && !controller.signal.aborted) setError(t('loadError')); });
    return () => controller.abort();
  }, [chosen, isCurrent, t, workspaceId]);
  const refresh = () => { void load(); onUpdated(); };
  async function applyProfile() {
    if (!profileCurrent.current || !profiles || !profiles.profiles.some(value => value.id === profileId && value.status === 'active')) throw new Error('profile_changed');
    if (profileId !== profiles.effectiveProfile.id) {
      await pluginIntegrationRequest('/api/composio/workspace-profile', workspaceId, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({workspaceId: profiles.workspace.id, profileId})});
    }
    if (!isCurrent()) throw new DOMException('Actor changed', 'AbortError');
  }
  async function connectPersonal() {
    if (!item || item.kind !== 'integration' || item.toolkit.noAuth || !personalAvailable || loading || !isCurrent() || pending) return;
    setPending(true); setError(null);
    try {
      await applyProfile();
      const path = pluginCatalogReturnPath(returnPath, locale, profiles?.workspace.id || workspaceId, new URL(returnPath, 'https://canvas.invalid').searchParams.has('resourceRef')
        ? {resourceRef: new URL(returnPath, 'https://canvas.invalid').searchParams.get('resourceRef')!} : {extensionId: item.id});
      const result = await pluginIntegrationRequest<{redirectUrl?: string; noAuth?: boolean}>(`/api/composio/connect/${encodeURIComponent(item.toolkit.slug)}`, workspaceId,
        {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({returnPath: path})});
      if (!isCurrent()) return;
      if (result.redirectUrl) {
        const url = new URL(result.redirectUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_redirect');
        window.location.assign(url.toString());
      } else refresh();
    } catch { if (isCurrent()) setError(t('saveError')); }
    finally { if (isCurrent()) setPending(false); }
  }
  async function selectProfileForWorkspace() {
    if (!isCurrent() || pending) return; setPending(true); setError(null);
    try { await applyProfile(); if (isCurrent()) refresh(); } catch { if (isCurrent()) setError(t('saveError')); } finally { if (isCurrent()) setPending(false); }
  }
  async function authorizeMcp() {
    if (!item || item.kind !== 'mcp' || !item.mcp.serverId || !mcpAuthRequired || !isCurrent() || pending) return;
    setPending(true); setError(null); oauth.current?.abort(); const controller = new AbortController(); oauth.current = controller;
    try {
      const flow = await startMcpAuthorization(item.mcp.serverId);
      if (!isCurrent()) { controller.abort(); return; }
      await waitForMcpAuthorization(flow, controller.signal, () => undefined);
      if (isCurrent() && !controller.signal.aborted) refresh();
    } catch (failure) { if (isCurrent() && !controller.signal.aborted) setError(t(failure instanceof McpAuthorizationError && failure.code === 'authorization_cancelled' ? 'oauthCancelled' : 'saveError')); }
    finally { if (isCurrent()) setPending(false); }
  }
  async function checkMcp() {
    if (!item || item.kind !== 'mcp' || !item.mcp.serverId || pending || !isCurrent()) return;
    setPending(true); setError(null);
    try { await pluginIntegrationRequest('/api/integrations/mcp-status', workspaceId, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({server: item.mcp.serverId, action: 'test'})}); if (isCurrent()) refresh(); }
    catch { if (isCurrent()) setError(t('loadError')); } finally { if (isCurrent()) setPending(false); }
  }
  async function loadTools() {
    if (!item || !isCurrent() || toolsLoading || chosen && shared(chosen)) return; setToolsLoading(true); setToolsError(false);
    try {
      const path = item.kind === 'integration' ? `/api/composio/toolkits/${encodeURIComponent(item.toolkit.slug)}/tools`
        : item.mcp.serverId ? `/api/integrations/mcp-tools?server=${encodeURIComponent(item.mcp.serverId)}` : null;
      if (!path) return;
      const value = await pluginIntegrationRequest<{tools?: Array<{name: string; description?: string}>}>(path, workspaceId);
      if (isCurrent()) setTools(Array.isArray(value.tools) ? value.tools : []);
    } catch { if (isCurrent()) setToolsError(true); } finally { if (isCurrent()) setToolsLoading(false); }
  }
  const afterSharedCreated = (value: IntegrationConnectionDescriptor) => { setCreateShared(false); setConnectionRef(value.resource.connectionRef); setSharedConnection(value); onUpdated(); void load(); };
  const statusLabel = (value: PluginExtensionConnection) => t(value.authorization === 'authorized' ? 'connected' : value.authorization === 'required' ? 'authRequired' : value.authorization === 'not_required' ? 'noAuth' : 'authorizationUnknown');
  const returned = new URL(returnPath, 'https://canvas.invalid'), packageRef = returned.searchParams.get('resourceRef');
  const exactReturn = item ? pluginCatalogReturnPath(returnPath, locale, profiles?.workspace.id || workspaceId, packageRef ? {resourceRef: packageRef} : {extensionId: item.id}) : returnPath;
  const sharedReturnStatus = returned.searchParams.get('sharedOAuth');
  if (editMcp && item?.kind === 'mcp') return <PluginMcpSetup workspaceId={workspaceId} item={item} returnPath={exactReturn} onClose={() => setEditMcp(false)} onCreated={() => { setEditMcp(false); refresh(); }} />;
  return <section className="min-w-0 space-y-5" data-testid="plugin-integration-detail">
    <header className="space-y-3"><div className="flex justify-between gap-2"><Button variant="ghost" onClick={onClose}>{t('back')}</Button><Button variant="outline" disabled={pending || loading} onClick={() => { if (confirmPluginNavigation()) refresh(); }} data-testid="plugin-integration-reload">{t('refresh')}</Button></div>
      <h2 className="text-xl font-semibold">{item?.displayName || initial.displayName}</h2>{item?.description ? <p className="max-w-3xl text-sm text-muted-foreground">{item.description}</p> : null}</header>
    {error ? <InlineNotice variant="destructive" size="compact">{error}</InlineNotice> : null}
    {loading ? <p role="status">{t('loading')}</p> : item ? <>
      {warnings.map(value => <InlineNotice key={value} variant="warning" size="compact" data-testid={`plugin-setup-${value}`}>{t(value)}</InlineNotice>)}
      {returned.searchParams.get('composioError') || sharedReturnStatus === 'cancelled' ? <InlineNotice size="compact">{t('oauthCancelled')}</InlineNotice> : null}
      {item.connections.length ? <div className="max-w-xl space-y-2"><Label htmlFor="plugin-integration-account">{t('account')}</Label>
        {item.connections.length === 1 ? <p className="text-sm">{item.connections[0].displayName}</p> : <select className={selectClass} id="plugin-integration-account" value={connectionRef} disabled={pending} onChange={event => { if (confirmPluginNavigation()) { setConnectionRef(event.target.value); const profile = item.connections.find(value => value.connectionRef === event.target.value)?.profileId; if (profile) setProfileId(profile); setCreateShared(false); } }}>
          <option value="">{t('selectConnection')}</option>{item.connections.map(value => <option key={value.connectionRef} value={value.connectionRef}>{value.displayName} · {value.ownershipLabel || t(shared(value) ? 'shared' : 'personal')}</option>)}</select>}
        {chosen ? <div className="flex flex-wrap gap-2 text-xs"><Badge variant="outline">{statusLabel(chosen)}</Badge><Badge variant="outline">{t(chosen.health === 'healthy' ? 'ready' : chosen.health === 'unavailable' ? 'unavailable' : 'unknown')}</Badge>{!chosen.access.canUse ? <Badge variant="secondary">{t('restricted')}</Badge> : null}</div> : null}
      </div> : <p className="text-sm text-muted-foreground">{t('noConnections')}</p>}
      {item.kind === 'integration' && (!chosen || !shared(chosen)) ? <div className="max-w-xl space-y-3">
        {item.toolkit.noAuth ? <InlineNotice size="compact">{t('noAuth')}</InlineNotice> : profiles && personalAvailable ? <>
          <Label htmlFor="plugin-integration-profile">{t('profile')}</Label>{profiles.profiles.filter(value => value.status === 'active').length === 1 ? <p className="text-sm">{profiles.effectiveProfile.name}</p> : <select className={selectClass} id="plugin-integration-profile" value={profileId} disabled={pending} onChange={event => setProfileId(event.target.value)}>
            <option value="">{t('selectProfile')}</option>{profiles.profiles.filter(value => value.status === 'active').map(value => <option key={value.id} value={value.id}>{value.name}{value.id === profiles.effectiveProfile.id ? ` · ${t('currentProfile')}` : ''}</option>)}</select>}
          {profileId !== profiles.effectiveProfile.id ? <p className="text-xs text-muted-foreground">{t('profileChangedHint')}</p> : null}
          <Button disabled={pending || !profileId} onClick={() => void connectPersonal()} data-testid="plugin-integration-connect">{t(chosen?.authorization === 'authorized' ? 'reauthorize' : 'connect')}</Button>
          {profileId !== profiles.effectiveProfile.id ? <Button variant="outline" disabled={pending || !profileId} onClick={() => void selectProfileForWorkspace()}>{t('useConnection')}</Button> : null}
        </> : !personalAvailable && !warnings.includes('profilesUnavailable') ? <InlineNotice size="compact">{t('metadataUnavailable')}</InlineNotice> : null}
      </div> : item.kind === 'mcp' && item.mcp.serverId ? <div className="flex flex-wrap gap-2">
        {mcpAuthRequired ? <Button disabled={pending} onClick={() => void authorizeMcp()} data-testid="plugin-mcp-authorize">{t(chosen?.authorization === 'authorized' ? 'reauthorize' : 'connect')}</Button> : null}
        <Button variant="outline" disabled={pending || !chosen?.enabled} onClick={() => void checkMcp()} data-testid="plugin-mcp-check">{t('check')}</Button>
      </div> : item.kind === 'mcp' && item.mcp.definitionId ? <Button disabled={pending} onClick={() => setEditMcp(true)}>{t('continueSetup')}</Button> : null}
      {sharedConnection && sharedConnection.resource.connectionRef === connectionRef ? <SharedConnectionEditor key={sharedConnection.resource.connectionRef} api={api} initial={sharedConnection} workspaceId={workspaceId}
        isCurrentSession={isCurrentShared} compact allowAuthorization={item.kind === 'mcp' ? sharedMcpAuthRequired : !item.toolkit.noAuth}
        onSaved={refresh} returnLocale={locale} returnPath={exactReturn} returnStatus={sharedReturnStatus === 'connected' || sharedReturnStatus === 'cancelled' || sharedReturnStatus === 'failed' ? sharedReturnStatus : undefined} /> : null}
      {item.kind === 'integration' && scopes.length ? <div className="space-y-4 border-t pt-4"><Button variant="outline" disabled={pending} onClick={() => { if (confirmPluginNavigation()) setCreateShared(value => !value); }} data-testid="plugin-integration-new-shared">{t('sharedSetup')}</Button>
        {createShared ? <SharedConnectionCreateForm api={api} scopes={scopes} initialSource="composio" initialToolkit={item.toolkit.slug} initialName={item.displayName} lockSource compact onSaved={() => undefined} onCreated={afterSharedCreated} /> : null}</div> : null}
      <p className="text-xs leading-relaxed text-muted-foreground">{t('managementSeparate')}</p>
      <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{t('advanced')}</summary><div className="mt-4 space-y-4">
        {item.kind === 'mcp' && item.mcp.serverId && canManageMcp ? <Button variant="outline" disabled={pending} onClick={() => setEditMcp(true)} data-testid="plugin-mcp-edit">{t('manage')}</Button> : null}
        {item.kind === 'integration' && profiles ? <div className="max-w-xl space-y-2"><Label htmlFor="plugin-integration-profile-name">{t('profileName')}</Label><Input id="plugin-integration-profile-name" value={profileName} maxLength={80} disabled={pending} onChange={event => setProfileName(event.target.value)} />
          <Button variant="outline" disabled={pending || !profileName.trim()} onClick={() => { setPending(true); void pluginIntegrationRequest('/api/composio/profiles', workspaceId, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: profileName})})
            .then(() => { if (isCurrent()) { setProfileName(''); refresh(); } }).catch(() => { if (isCurrent()) setError(t('saveError')); }).finally(() => { if (isCurrent()) setPending(false); }); }}>{t('createProfile')}</Button></div> : null}
        {!chosen || !shared(chosen) ? <div className="space-y-2"><Button variant="outline" disabled={toolsLoading} onClick={() => void loadTools()}>{t('tools')}</Button>{toolsError ? <p className="text-sm">{t('toolsError')}</p> : null}
          <ul className="space-y-2">{tools.map(value => <li key={value.name} className="text-sm"><p className="font-medium">{value.name}</p>{value.description ? <p className="text-muted-foreground">{value.description}</p> : null}</li>)}</ul></div> : null}
      </div></details>
    </> : null}
  </section>;
}
