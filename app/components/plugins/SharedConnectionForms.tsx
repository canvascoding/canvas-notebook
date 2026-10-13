'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { IntegrationConnectionDescriptor, IntegrationConnectionGrantInput, IntegrationConnectionScopeChoice,
  IntegrationConnectionTargetCatalog } from '@/app/lib/integration-tools/connections/contracts';
import { SearchablePolicyTargetPicker, type PolicyTargetOption } from '@/app/components/organization/SearchablePolicyTargetPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SharedConnectionRequestError, type SharedConnectionApi } from './shared-connections-client';
import { SharedMcpAuthorizationError, startSharedMcpAuthorization, waitForSharedMcpAuthorization, cancelSharedMcpAuthorization, readSharedMcpAuthorizationStatus, finalizeSharedMcpAuthorization,
  type SharedMcpAuthorizationFlow, type SharedMcpAuthorizationOptions, type SharedMcpAuthorizationSummary } from '@/app/lib/desktop/shared-mcp-oauth-client';
import { SharedComposioAuthorizationError, isSharedComposioAuthorizationPermanentError, startSharedComposioAuthorization,
  waitForSharedComposioAuthorization, cancelSharedComposioAuthorization, resumeSharedComposioAuthorization,
  type SharedComposioAuthorizationFlow, type SharedComposioAuthorizationOptions, type SharedComposioAuthorizationSummary,
  type SharedComposioAuthorizationStartResult } from '@/app/lib/desktop/shared-composio-oauth-client';
import { isSharedConnectionConnected } from './shared-connection-oauth-state';
import { confirmPluginNavigation, hasPluginNavigationBlockers, usePluginEditorNavigationGuard } from './plugin-navigation-guard';

const EMPTY_TARGETS: IntegrationConnectionTargetCatalog = { users: [], workspaces: [], projects: [], agents: [] };
const tools = (value: string): string[] | null => value.trim() ? [...new Set(value.split(/[\n,]/u).map(name => name.trim()).filter(Boolean))] : null;
const revisions = (value: IntegrationConnectionDescriptor) => ({ expectedMetadataRevision: value.resource.metadataRevision,
  expectedGrantsRevision: value.resource.grantsRevision, expectedBindingRevision: value.resource.bindingRevision });
const choice = (scope: IntegrationConnectionScopeChoice) => scope.ownership.type === 'team'
  ? { type: 'team' as const, workspaceId: scope.ownership.workspaceId } : { type: 'organization' as const };
const scopeQuery = (scope: IntegrationConnectionScopeChoice) => new URLSearchParams({ ownershipType: scope.ownership.type,
  ...(scope.ownership.type === 'team' ? { teamWorkspaceId: scope.ownership.workspaceId } : {}) });
const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';
const composioSetupCodes = ['setup_required', 'master_key_missing', 'decryption_failed', 'invalid_secret_format', 'mcp_credential_key_missing'];
type SharedDesktopFlow = { source: 'mcp'; flow: SharedMcpAuthorizationFlow }
  | { source: 'composio'; flow: SharedComposioAuthorizationFlow };
type SharedDesktopOutcome = { source: 'mcp'; result: SharedMcpAuthorizationSummary }
  | { source: 'composio'; result: SharedComposioAuthorizationSummary };

export function SharedConnectionCreateForm({ api, scopes, onSaved, onCreated, initialSource = 'mcp', initialToolkit = '', initialName = '', initialConfig, lockSource = false, compact = false }: {
  api: SharedConnectionApi; scopes: IntegrationConnectionScopeChoice[]; onSaved: () => void; onCreated?: (connection: IntegrationConnectionDescriptor) => void;
  initialSource?: 'mcp' | 'composio'; initialToolkit?: string; initialName?: string; initialConfig?: Record<string, unknown>; lockSource?: boolean; compact?: boolean;
}) {
  const t = useTranslations('sharedConnections');
  const [scopeIndex, setScopeIndex] = useState(scopes.length === 1 ? 0 : -1), [source, setSource] = useState<'mcp' | 'composio'>(initialSource);
  const [name, setName] = useState(initialName), [url, setUrl] = useState(typeof initialConfig?.url === 'string' ? initialConfig.url : ''), [token, setToken] = useState(''), [oauth, setOAuth] = useState(initialConfig?.auth === 'oauth');
  const [app, setApp] = useState(initialToolkit), [profiles, setProfiles] = useState<Array<{ id: string; name: string; providerMode: string }>>([]);
  const [profileId, setProfileId] = useState(''), [profileName, setProfileName] = useState(''), [mode, setMode] = useState<'local' | 'managed'>('local');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<IntegrationConnectionDescriptor | null>(null), [profileTouched, setProfileTouched] = useState(false);
  const scope = scopes[scopeIndex], alive = useRef(true), request = useRef(0);
  const dirty = !completed && (scopeIndex !== (scopes.length === 1 ? 0 : -1) || source !== initialSource || mode !== 'local'
    || oauth !== (initialConfig?.auth === 'oauth') || name !== initialName || url !== (typeof initialConfig?.url === 'string' ? initialConfig.url : '')
    || token !== '' || app !== initialToolkit || profileName !== '' || profileTouched);
  // Only the parent's actual API-write counter supplies pending authority; busy also covers OAuth redirects and reads.
  usePluginEditorNavigationGuard({ dirty, pending: false });
  const reported = useRef(false);
  useEffect(() => { if (completed && !busy && !reported.current) { reported.current = true; onCreated?.(completed); onSaved(); } }, [completed, busy, onCreated, onSaved]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current += 1; }; }, []);
  const loadProfiles = useCallback(async () => {
    const current = ++request.current;
    setProfiles([]); setProfileId(''); setLoading(true); setError(null);
    if (!scope) { setLoading(false); return; }
    try {
      const result = await api<{ profiles: Array<{ id: string; name: string; providerMode: string }> }>(`/api/composio/shared-profiles?${scopeQuery(scope)}`);
      if (alive.current && request.current === current) { setProfiles(result.profiles); if (result.profiles.length === 1) setProfileId(result.profiles[0].id); }
    } catch { if (alive.current && request.current === current) setError(t('loadError')); }
    finally { if (alive.current && request.current === current) setLoading(false); }
  }, [api, scope, t]);
  useEffect(() => { if (source === 'composio') queueMicrotask(() => void loadProfiles()); }, [source, loadProfiles]);
  async function createProfile() {
    if (!scope) return;
    setBusy(true); setError(null);
    try {
      const result = await api<{ profile: { id: string; name: string; providerMode: string } }>('/api/composio/shared-profiles',
        { name: profileName, ownership: choice(scope), providerMode: mode });
      if (!alive.current) return;
      setProfiles(current => [...current, result.profile]); setProfileId(result.profile.id); setProfileName('');
    } catch { if (alive.current) setError(t('saveError')); }
    finally { if (alive.current) setBusy(false); }
  }
  async function create() {
    if (!scope) return;
    setBusy(true); setError(null);
    try {
      const result = await api<{connection: IntegrationConnectionDescriptor}>('/api/integrations/shared-connections', { displayName: name, ownership: choice(scope), source,
        ...(source === 'composio' ? { profileId, toolkit: app } : { config: { url, transport: 'http',
          ...(oauth ? { auth: 'oauth' } : {}), ...(token && !oauth ? { bearerTokenEnv: 'MCP_SLOT_TOKEN' } : {}) },
          secrets: token && !oauth ? [{ name: 'TOKEN', value: token }] : [] }) });
      if (alive.current) { setToken(''); setCompleted(result.connection); }
    } catch (failure) { if (alive.current) setError(failure instanceof SharedConnectionRequestError && failure.code === 'setup_required'
      && profiles.find(profile => profile.id === profileId)?.providerMode === 'local' ? t('secretsRequired') : t('saveError')); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="space-y-4" data-testid="shared-connection-create-form">
    {error ? <InlineNotice variant="destructive" size="compact" actions={error === t('secretsRequired') ? <Link href="/settings?tab=secrets">{t('openSecrets')}</Link> : undefined}>{error}</InlineNotice> : null}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="shared-owner">{t('owner')}</Label>{compact && scopes.length === 1 ? <p className="py-2 text-sm">{scopes[0].ownership.type === 'team' ? `${t('team')} · ${scopes[0].label}` : t('organization')}</p> : <select id="shared-owner" className={selectClass} value={scopeIndex} disabled={busy} onChange={event => setScopeIndex(Number(event.target.value))}>
        <option value={-1}>{t('chooseTarget')}</option>
        {scopes.map((entry, index) => <option key={index} value={index}>{entry.ownership.type === 'team' ? `${t('team')} · ${entry.label}` : t('organization')}</option>)}</select>}</div>
      <div className="space-y-1"><Label htmlFor="shared-source">{t('source')}</Label>{lockSource || initialToolkit ? <p className="py-2 text-sm">{t(source)}</p> : <select id="shared-source" className={selectClass} value={source} disabled={busy || Boolean(initialToolkit)} onChange={event => setSource(event.target.value as 'mcp' | 'composio')}>
        <option value="mcp">{t('mcp')}</option><option value="composio">{t('composio')}</option></select>}</div>
    </div>
    <div className="space-y-1"><Label htmlFor="shared-name">{t('name')}</Label><Input id="shared-name" value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)} /></div>
    {source === 'mcp' ? <>
      <div className="space-y-1"><Label htmlFor="shared-url">{t('endpoint')}</Label><Input id="shared-url" type="url" value={url} disabled={busy} placeholder="https://…" onChange={event => setUrl(event.target.value)} /></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={oauth} disabled={busy} onChange={event => { setOAuth(event.target.checked); setToken(''); }} />{t('oauth')}</label>
      {!oauth ? <div className="space-y-1"><Label htmlFor="shared-token">{t('token')}</Label><Input id="shared-token" type="password" autoComplete="new-password" value={token} disabled={busy} onChange={event => setToken(event.target.value)} /><p className="text-xs text-muted-foreground">{t('tokenHint')}</p></div> : null}
    </> : <>
      <div className="space-y-1"><Label htmlFor="shared-profile">{t('profile')}</Label>{compact && profiles.length === 1 ? <p className="py-2 text-sm">{profiles[0].name}</p> : <select id="shared-profile" className={selectClass} value={profileId} disabled={busy || loading} onChange={event => { setProfileId(event.target.value); setProfileTouched(true); }}>
        <option value="">{t('chooseProfile')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select>}</div>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('newProfile')}</summary><div className="mt-3 space-y-3">
        <Label htmlFor="shared-profile-name">{t('profileName')}</Label><Input id="shared-profile-name" value={profileName} maxLength={80} disabled={busy || loading} onChange={event => setProfileName(event.target.value)} />
        <Label htmlFor="shared-profile-mode">{t('accessSource')}</Label><select id="shared-profile-mode" className={selectClass} value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'local' | 'managed')}>
          <option value="local">{t('localMode')}</option><option value="managed">{t('managedMode')}</option></select>
        <p className="text-xs text-muted-foreground">{t('profileHint')}</p><Button type="button" variant="outline" onClick={() => void createProfile()} disabled={busy || loading || !profileName.trim()}>{t('createProfile')}</Button>
      </div></details>
      <div className="space-y-1"><Label htmlFor="shared-app">{t('app')}</Label>{initialToolkit ? <p className="py-2 text-sm">{initialToolkit}</p> : <Input id="shared-app" value={app} maxLength={100} placeholder="canva" disabled={busy || Boolean(initialToolkit)} onChange={event => setApp(event.target.value)} />}</div>
    </>}
    <p className="text-xs leading-5 text-muted-foreground">{t('restrictedDefault')}</p>
    <Button className="w-full sm:w-auto" onClick={() => void create()} disabled={busy || loading || !scope || !name.trim() || (source === 'mcp' ? !url.trim() : !profileId || !app.trim())}>{busy ? t('saving') : t('create')}</Button>
  </div>;
}

export function SharedConnectionEditor({ api, initial, onSaved, returnLocale, returnStatus, returnPath, compact = false, allowAuthorization = true, workspaceId, isCurrentSession }: {
  workspaceId: string | null; isCurrentSession: (connectionRef: string) => boolean;
  api: SharedConnectionApi; initial: IntegrationConnectionDescriptor; onSaved: () => void;
  returnLocale?: 'de' | 'en'; returnStatus?: 'connected' | 'cancelled' | 'failed';
  returnPath?: string; compact?: boolean; allowAuthorization?: boolean;
}) {
  const t = useTranslations('sharedConnections');
  const [connection, setConnection] = useState(initial), [targets, setTargets] = useState(EMPTY_TARGETS);
  const [name, setName] = useState(initial.resource.displayName), [description, setDescription] = useState(initial.resource.description || '');
  const [responsible, setResponsible] = useState(initial.resource.responsibleUserId || ''), [grantList, setGrantList] = useState<IntegrationConnectionGrantInput[]>([]);
  const [accessMode, setAccessMode] = useState(initial.resource.accessMode), [allowedTools, setAllowedTools] = useState((initial.resource.allowedToolNames || []).join('\n'));
  const [toolMode, setToolMode] = useState<'all' | 'none' | 'selected'>(initial.resource.allowedToolNames === null ? 'all' : initial.resource.allowedToolNames.length ? 'selected' : 'none');
  const [targetType, setTargetType] = useState<IntegrationConnectionGrantInput['targetType']>('user'), [targetId, setTargetId] = useState('');
  const [canUse, setCanUse] = useState(false), [canManage, setCanManage] = useState(false), [grantTools, setGrantTools] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [ready, setReady] = useState(false), [conflict, setConflict] = useState(false), [error, setError] = useState<string | null>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null), [accounts, setAccounts] = useState<Array<{ accountRef: string; label: string; selectable: boolean }>>([]), [accountRef, setAccountRef] = useState('');
  const [status, setStatus] = useState<string | null>(null), alive = useRef(true);
  const desktopFlowRef = useRef<SharedDesktopFlow | null>(null), desktopController = useRef<AbortController | null>(null);
  const desktopOutcome = useRef<SharedDesktopOutcome | null>(null);
  const [desktopFlow, setDesktopFlow] = useState<SharedDesktopFlow | null>(null), [desktopCancelling, setDesktopCancelling] = useState(false);
  const desktopPending = useCallback(() => desktopFlowRef.current !== null, []);
  const [repairConfiguration, setRepairConfiguration] = useState(''), [repairSecrets, setRepairSecrets] = useState('');
  const dirty = ready && (
    name !== connection.resource.displayName || description !== (connection.resource.description || '')
    || responsible !== (connection.resource.responsibleUserId || '') || accessMode !== connection.resource.accessMode
    || toolMode !== (connection.resource.allowedToolNames === null ? 'all' : connection.resource.allowedToolNames.length ? 'selected' : 'none')
    || allowedTools !== (connection.resource.allowedToolNames || []).join('\n')
    || JSON.stringify(grantList) !== JSON.stringify((connection.grants || []).map(({ targetType, targetId, canUse, canManage, allowedToolNames }) => ({ targetType, targetId, canUse, canManage, allowedToolNames })))
  ) || targetId !== '' || canUse || canManage || grantTools !== '' || accountRef !== '' || repairConfiguration !== '' || repairSecrets !== '';
  usePluginEditorNavigationGuard({ dirty, pending: desktopPending });
  const path = `/api/integrations/shared-connections/${encodeURIComponent(initial.resource.connectionRef)}`;
  const providerPath = `/api/${initial.resource.source}/shared-connections/${encodeURIComponent(initial.resource.connectionRef)}`;
  const load = useCallback(async (desktopCompleted = false) => {
    if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
    setLoading(true); setReady(false); setError(null); setAccounts([]); setAccountRef(''); setStatus(null); setTargets(EMPTY_TARGETS);
    try {
      const value = (await api<{ connection: IntegrationConnectionDescriptor }>(path)).connection;
      if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
      if (value.resource.connectionRef !== initial.resource.connectionRef || value.resource.source !== initial.resource.source) throw new Error('connection_selection_unavailable');
      setConnection(value); setName(value.resource.displayName); setDescription(value.resource.description || ''); setResponsible(value.resource.responsibleUserId || '');
      setAccessMode(value.resource.accessMode); setAllowedTools((value.resource.allowedToolNames || []).join('\n'));
      setToolMode(value.resource.allowedToolNames === null ? 'all' : value.resource.allowedToolNames.length ? 'selected' : 'none');
      setGrantList((value.grants || []).map(({ targetType, targetId, canUse, canManage, allowedToolNames }) => ({ targetType, targetId, canUse, canManage, allowedToolNames })));
      if (value.access.canManage) {
        const result = await api<{ targets: IntegrationConnectionTargetCatalog }>(`${path}/targets`);
        if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
        setTargets(result.targets);
      }
      if ((desktopCompleted || returnStatus === 'connected') && value.access.canManage) {
        const current = await api<unknown>(`${providerPath}/${value.resource.source === 'mcp' ? 'oauth' : 'status'}`);
        if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
        const connected = isSharedConnectionConnected(value.resource.source, current);
        setStatus(t(connected ? 'connected' : 'connectionRequired'));
      } else if (returnStatus === 'cancelled' || returnStatus === 'failed') {
        if (alive.current && isCurrentSession(initial.resource.connectionRef)) setStatus(t(returnStatus === 'cancelled' ? 'oauthCancelled' : 'oauthFailed'));
      }
      if (alive.current && isCurrentSession(initial.resource.connectionRef)) setReady(true);
    } catch { if (alive.current && isCurrentSession(initial.resource.connectionRef)) setError(t('loadError')); }
    finally { if (alive.current && isCurrentSession(initial.resource.connectionRef)) setLoading(false); }
  }, [api, initial.resource.connectionRef, initial.resource.source, isCurrentSession, path, providerPath, returnStatus, t]);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; desktopController.current?.abort(); }; }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  const userOptions: PolicyTargetOption[] = targets.users.map(user => ({ id: user.userId, label: user.name || user.email || t('unknownTarget'), description: user.name ? user.email : null }));
  const options: PolicyTargetOption[] = targetType === 'user' ? userOptions
    : targetType === 'workspace' ? targets.workspaces.map(value => ({ id: value.workspaceId, label: value.name, description: null }))
      : targetType === 'project' ? targets.projects.map(value => ({ id: value.projectId, label: value.name, description: null }))
        : targetType === 'agent' ? targets.agents.map(value => ({ id: value.agentId, label: value.name, description: null }))
          : targetType === 'role' ? ['owner', 'admin', 'member', 'external'].map(value => ({ id: value, label: t(`roles.${value}`), description: null }))
            : [{ id: connection.resource.ownership.organizationId, label: t('organization'), description: null }];
  const targetLabel = (grant: IntegrationConnectionGrantInput) => grant.targetType === 'user' ? userOptions.find(value => value.id === grant.targetId)?.label
    : grant.targetType === 'workspace' ? targets.workspaces.find(value => value.workspaceId === grant.targetId)?.name
      : grant.targetType === 'project' ? targets.projects.find(value => value.projectId === grant.targetId)?.name
        : grant.targetType === 'agent' ? targets.agents.find(value => value.agentId === grant.targetId)?.name
          : grant.targetType === 'role' ? t(`roles.${grant.targetId}`) : t('organization');
  const disabled = loading || busy || conflict || !ready || desktopFlow !== null;
  async function run(operation: () => Promise<void>) {
    if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
    setBusy(true); setError(null);
    try { await operation(); }
    catch (failure) { if (alive.current && isCurrentSession(initial.resource.connectionRef)) { const stale = failure instanceof SharedConnectionRequestError && failure.status === 409; setConflict(stale); setError(t(stale ? 'conflict' : 'saveError')); } }
    finally { if (alive.current && isCurrentSession(initial.resource.connectionRef)) setBusy(false); }
  }
  async function save() {
    await run(async () => {
      await api(path, { ...revisions(connection), metadata: { displayName: name, description, responsibleUserId: responsible || null },
        grants: grantList, accessMode, allowedToolNames: toolMode === 'all' ? null : toolMode === 'none' ? [] : tools(allowedTools) ?? [] }, 'PATCH');
      if (alive.current && isCurrentSession(initial.resource.connectionRef)) onSaved();
    });
  }
  function desktopOptions(controller: AbortController): SharedMcpAuthorizationOptions;
  function desktopOptions(controller: AbortController, source: 'composio'): SharedComposioAuthorizationOptions;
  function desktopOptions(controller: AbortController, source: 'mcp' | 'composio' = 'mcp'): SharedMcpAuthorizationOptions | SharedComposioAuthorizationOptions {
    if (source === 'composio') return { api, signal: controller.signal,
      isCurrent: () => alive.current && isCurrentSession(initial.resource.connectionRef),
      onStatus: (value: SharedComposioAuthorizationSummary) => { desktopOutcome.current = { source: 'composio', result: value }; } };
    return { api, signal: controller.signal, isCurrent: () => alive.current && isCurrentSession(initial.resource.connectionRef),
      ...(workspaceId !== null && returnLocale ? { returnLocale } : {}),
      onStatus: (value: SharedMcpAuthorizationSummary) => { desktopOutcome.current = { source: 'mcp', result: value }; } };
  }
  async function clearDesktopFlow(result: SharedMcpAuthorizationSummary | SharedComposioAuthorizationSummary
    | Extract<SharedComposioAuthorizationStartResult, { noAuth: true }>) {
    if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
    if (!('noAuth' in result) && (result.status === 'starting' || result.status === 'waiting' || result.status === 'callback_received')) {
      setError(t('desktopUnconfirmed')); return;
    }
    desktopController.current?.abort(); desktopController.current = null; desktopFlowRef.current = null; setDesktopFlow(null);
    if ('noAuth' in result || result.status === 'completed') await load(true);
    else setStatus(t(result.status === 'cancelled' ? 'oauthCancelled' : 'oauthFailed'));
  }
  async function cancelDesktopFlow() {
    const flow = desktopFlowRef.current;
    if (!flow || desktopCancelling || !alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
    desktopController.current?.abort();
    const controller = new AbortController(); desktopController.current = controller;
    setDesktopCancelling(true); setError(null);
    try { await clearDesktopFlow(flow.source === 'mcp'
      ? await cancelSharedMcpAuthorization(flow.flow, desktopOptions(controller))
      : await cancelSharedComposioAuthorization(flow.flow, desktopOptions(controller, 'composio'))); }
    catch (failure) { if (alive.current && isCurrentSession(initial.resource.connectionRef)) {
      const failureStatus = failure instanceof SharedMcpAuthorizationError || failure instanceof SharedComposioAuthorizationError ? failure.status : null;
      const setupRequired = failure instanceof SharedComposioAuthorizationError && composioSetupCodes.includes(failure.code);
      const denied = flow.source === 'mcp'
        ? failure instanceof SharedMcpAuthorizationError && failure.status !== null && [400, 401, 403, 404, 409, 410].includes(failure.status)
        : isSharedComposioAuthorizationPermanentError(failure);
      if (denied) { desktopController.current?.abort(); desktopFlowRef.current = null; setDesktopFlow(null); setReady(false); setConflict(failureStatus === 409); }
      setError(t(setupRequired ? 'secretsRequired' : denied ? failureStatus === 409 ? 'conflict' : 'oauthFailed' : 'desktopUnconfirmed'));
    } }
    finally { if (alive.current && isCurrentSession(initial.resource.connectionRef)) setDesktopCancelling(false); }
  }
  async function resumeDesktopFlow() {
    const flow = desktopFlowRef.current;
    if (!flow || busy || desktopCancelling || !alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
    const controller = new AbortController(); desktopController.current?.abort(); desktopController.current = controller;
    await run(async () => {
      try {
        if (flow.source === 'composio') {
          await clearDesktopFlow(await resumeSharedComposioAuthorization(flow.flow, desktopOptions(controller, 'composio')));
        } else {
          let result = await readSharedMcpAuthorizationStatus(flow.flow, desktopOptions(controller));
          if (result.status === 'callback_received') result = await finalizeSharedMcpAuthorization(flow.flow, desktopOptions(controller));
          if (result.status === 'waiting' || result.status === 'callback_received') {
            setStatus(t('desktopWaiting'));
            result = await waitForSharedMcpAuthorization(flow.flow, desktopOptions(controller));
          }
          await clearDesktopFlow(result);
        }
      } catch (failure) {
        if (!alive.current || !isCurrentSession(initial.resource.connectionRef) || controller.signal.aborted) return;
        const failureStatus = failure instanceof SharedMcpAuthorizationError || failure instanceof SharedComposioAuthorizationError ? failure.status : null;
        const setupRequired = failure instanceof SharedComposioAuthorizationError && composioSetupCodes.includes(failure.code);
        const denied = flow.source === 'mcp'
          ? failure instanceof SharedMcpAuthorizationError && failure.status !== null && [400, 401, 403, 404, 409, 410].includes(failure.status)
          : isSharedComposioAuthorizationPermanentError(failure);
        if (denied) { desktopController.current?.abort(); desktopFlowRef.current = null; setDesktopFlow(null); setReady(false); setConflict(failureStatus === 409); }
        setError(t(setupRequired ? 'secretsRequired' : denied ? failureStatus === 409 ? 'conflict' : 'oauthFailed' : 'desktopUnconfirmed'));
      }
    });
  }
  async function authorize() {
    if (hasPluginNavigationBlockers()) { setError(t('saveBeforeConnect')); return; }
    await run(async () => {
      if (Reflect.get(window, 'canvasDesktop')) {
        const controller = new AbortController(); desktopController.current = controller; desktopOutcome.current = null;
        try {
          if (connection.resource.source === 'mcp') {
            const flow = await startSharedMcpAuthorization({ connectionRef: initial.resource.connectionRef, workspaceId }, revisions(connection), {
              ...desktopOptions(controller), onStarted: value => { const current: SharedDesktopFlow = { source: 'mcp', flow: value };
                desktopFlowRef.current = current; setDesktopFlow(current); setStatus(t('desktopWaiting')); },
            });
            await clearDesktopFlow(await waitForSharedMcpAuthorization(flow, desktopOptions(controller)));
          } else {
            const flow = await startSharedComposioAuthorization({ connectionRef: initial.resource.connectionRef, workspaceId }, revisions(connection), {
              ...desktopOptions(controller, 'composio'), onStarted: value => { const current: SharedDesktopFlow = { source: 'composio', flow: value };
                desktopFlowRef.current = current; setDesktopFlow(current); setStatus(t('desktopWaiting')); },
            });
            await clearDesktopFlow('noAuth' in flow ? flow : await waitForSharedComposioAuthorization(flow, desktopOptions(controller, 'composio')));
          }
        } catch (failure) {
          if (!alive.current || !isCurrentSession(initial.resource.connectionRef) || controller.signal.aborted) return;
          const outcome = desktopOutcome.current as SharedDesktopOutcome | null;
          if (outcome && outcome.source === connection.resource.source && ['completed', 'cancelled', 'expired', 'failed'].includes(outcome.result.status)) {
            await clearDesktopFlow(outcome.result); return;
          }
          const failureStatus = failure instanceof SharedMcpAuthorizationError || failure instanceof SharedComposioAuthorizationError ? failure.status : null;
          const setupRequired = failure instanceof SharedComposioAuthorizationError && composioSetupCodes.includes(failure.code);
          const denied = connection.resource.source === 'mcp'
            ? failure instanceof SharedMcpAuthorizationError && failure.status !== null && [400, 401, 403, 404, 409, 410].includes(failure.status)
            : isSharedComposioAuthorizationPermanentError(failure);
          if (denied) { desktopController.current?.abort(); desktopFlowRef.current = null; setDesktopFlow(null); setReady(false); setConflict(failureStatus === 409); }
          setError(t((failure instanceof SharedMcpAuthorizationError || failure instanceof SharedComposioAuthorizationError) && failure.code === 'desktop_update_required'
            ? 'desktopUpdateRequired' : setupRequired ? 'secretsRequired' : denied && failureStatus === 409 ? 'conflict' : desktopFlowRef.current ? 'desktopUnconfirmed' : 'oauthFailed'));
        }
        return;
      }
      const result = await api<{ redirectUrl?: string | null; authorizationUrl?: string }>(`${providerPath}/${connection.resource.source === 'mcp' ? 'oauth' : 'connect'}`,
        { ...revisions(connection), ...(returnLocale ? { returnLocale } : {}), ...(returnPath ? { catalogReturnPath: returnPath } : {}) });
      if (!alive.current || !isCurrentSession(initial.resource.connectionRef)) return;
      const redirect = result.authorizationUrl || result.redirectUrl;
      if (!redirect) { await load(); return; }
      const url = new URL(redirect);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_authorization_url');
      window.location.assign(url.toString());
    });
  }
  async function loadAccounts() {
    await run(async () => {
      const result = await api<{ accounts: Array<{ accountRef: string; label: string; selectable: boolean }> }>(`${providerPath}/accounts`);
      if (alive.current && isCurrentSession(initial.resource.connectionRef)) { setAccounts(result.accounts); setAccountRef(''); }
    });
  }
  function reload() {
    if (!confirmPluginNavigation()) return;
    setConflict(false); setTargetId(''); setCanUse(false); setCanManage(false); setGrantTools('');
    setRepairConfiguration(''); setRepairSecrets(''); setAccounts([]); setAccountRef('');
    void load();
  }
  return <div ref={setPortal} className="space-y-4" data-testid="shared-connection-editor">
    <p className="text-sm text-muted-foreground">{connection.resource.description || t('separateAccountHint')}</p>
    <p className="text-xs text-muted-foreground">{connection.access.canUse ? t('canUse') : t('managementOnly')}</p>
    {error ? <InlineNotice variant="destructive" size="compact" actions={error === t('secretsRequired') ? <Link href="/settings?tab=secrets" target="_blank" rel="noopener noreferrer">{t('openSecrets')}</Link> : undefined}>{error}</InlineNotice> : null}
    <Button size="sm" variant="outline" disabled={busy} onClick={reload} data-testid="shared-connection-editor-reload">{t('reload')}</Button>
    {connection.access.canManage ? <>
      <details open={compact || Boolean(returnStatus)} className="space-y-3 rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('accountSetup')}</summary>
        <div className="space-y-3 pt-3">
          <p className="text-xs text-muted-foreground">{t('accountHint')}</p>
          <div className="flex flex-wrap gap-2">{allowAuthorization ? <Button size="sm" disabled={disabled} onClick={() => void authorize()} data-testid="shared-connection-authorize">{t('connect')}</Button> : connection.resource.source === 'composio' ? <Button size="sm" disabled={disabled} onClick={() => void run(async () => {
              const value = await api<{noAuth?: boolean}>(`${providerPath}/connect`, revisions(connection));
              if (value.noAuth !== true) throw new Error('authentication_mode_changed');
              if (alive.current && isCurrentSession(initial.resource.connectionRef)) { await load(); onSaved(); }
            })}>{t('saveSetup')}</Button> : null}
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run(async () => {
              const result = await api<unknown>(`${providerPath}/${connection.resource.source === 'mcp' ? 'oauth' : 'status'}`);
              if (alive.current && isCurrentSession(initial.resource.connectionRef)) setStatus(t(isSharedConnectionConnected(connection.resource.source, result) ? 'connected' : 'connectionRequired'));
            })}>{t('checkStatus')}</Button>
            {allowAuthorization ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run(async () => {
              await api(`${providerPath}/${connection.resource.source === 'mcp' ? 'oauth' : 'disconnect'}`, revisions(connection), connection.resource.source === 'mcp' ? 'DELETE' : 'POST');
              if (alive.current && isCurrentSession(initial.resource.connectionRef)) await load();
            })}>{t('disconnect')}</Button> : null}</div>
          {status ? <p className="text-sm">{status}</p> : null}
          {desktopFlow ? <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || desktopCancelling} onClick={() => void resumeDesktopFlow()} data-testid="shared-desktop-resume">{t('desktopCheck')}</Button>
            <Button size="sm" variant="outline" disabled={desktopCancelling} onClick={() => void cancelDesktopFlow()} data-testid="shared-desktop-cancel">{t('desktopCancel')}</Button>
          </div> : null}
          {connection.resource.source === 'composio' && allowAuthorization ? <><Button size="sm" variant="outline" disabled={disabled} onClick={() => void loadAccounts()}>{t('loadAccounts')}</Button>
            {accounts.length ? <div className="space-y-2"><Label htmlFor="shared-account">{t('account')}</Label><select id="shared-account" className={selectClass} value={accountRef} disabled={disabled} onChange={event => setAccountRef(event.target.value)}>
              <option value="">{t('chooseAccount')}</option>{accounts.map(account => <option key={account.accountRef} value={account.accountRef} disabled={!account.selectable}>{account.label}</option>)}</select>
              <Button size="sm" disabled={disabled || !accountRef} onClick={() => void run(async () => { await api(`${providerPath}/accounts`, { ...revisions(connection), accountRef }, 'PATCH'); if (alive.current && isCurrentSession(initial.resource.connectionRef)) await load(); })}>{t('bindAccount')}</Button></div> : null}</> : null}
          {connection.resource.source === 'mcp' ? <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">{t('repairSetup')}</summary><div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">{t('repairHint')}</p><Label htmlFor="shared-repair-config">{t('configuration')}</Label><Textarea id="shared-repair-config" className="font-mono text-xs" value={repairConfiguration} disabled={disabled} onChange={event => setRepairConfiguration(event.target.value)} placeholder={'{"url":"https://…","transport":"http"}'} />
            <Label htmlFor="shared-repair-secrets">{t('secretSlots')}</Label><Textarea id="shared-repair-secrets" className="font-mono text-xs" value={repairSecrets} disabled={disabled} onChange={event => setRepairSecrets(event.target.value)} placeholder={'[{"name":"TOKEN","value":"…"}]'} />
            <Button size="sm" variant="outline" disabled={disabled || !repairConfiguration.trim()} onClick={() => void run(async () => {
              const config: unknown = JSON.parse(repairConfiguration), secrets: unknown = repairSecrets.trim() ? JSON.parse(repairSecrets) : [];
              await api(`${providerPath}/configuration`, { ...revisions(connection), config, secrets }, 'PUT');
              if (alive.current && isCurrentSession(initial.resource.connectionRef)) { setRepairSecrets(''); await load(); }
            })}>{t('saveSetup')}</Button>
          </div></details> : null}
        </div>
      </details>
      <details className="space-y-3 rounded-lg border p-3" open={!compact}><summary className="cursor-pointer text-sm font-medium">{t('metadataAndGrants')}</summary>
        <div className="space-y-4 pt-3">
          <div className="space-y-1"><Label htmlFor="shared-edit-name">{t('name')}</Label><Input id="shared-edit-name" value={name} maxLength={200} disabled={disabled} onChange={event => setName(event.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="shared-edit-description">{t('descriptionField')}</Label><Textarea id="shared-edit-description" value={description} maxLength={4096} disabled={disabled} onChange={event => setDescription(event.target.value)} /></div>
          <div className="space-y-1"><Label>{t('responsible')}</Label><div className="flex min-w-0 gap-2"><div className="min-w-0 flex-1"><SearchablePolicyTargetPicker id="shared-responsible" value={responsible} options={userOptions}
            portalContainer={portal} label={t('responsible')} placeholder={t('choosePerson')} searchPlaceholder={t('search')} emptyLabel={t('noTargets')} disabled={disabled}
            testId="shared-responsible" onValueChange={setResponsible} /></div><Button size="sm" variant="outline" disabled={disabled || !responsible} onClick={() => setResponsible('')}>{t('clear')}</Button></div></div>
          <div className="space-y-1"><Label htmlFor="shared-access-mode">{t('access')}</Label><select id="shared-access-mode" className={selectClass} value={accessMode} disabled={disabled} onChange={event => setAccessMode(event.target.value as 'restricted' | 'inherit')}>
            <option value="restricted">{t('restricted')}</option><option value="inherit">{t('inherited')}</option></select><p className="text-xs text-muted-foreground">{t('inheritHint')}</p></div>
          <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('toolLimits')}</summary><div className="mt-2 space-y-2"><Label htmlFor="shared-tool-mode">{t('toolLimits')}</Label><select id="shared-tool-mode" className={selectClass} value={toolMode} disabled={disabled} onChange={event => setToolMode(event.target.value as typeof toolMode)}><option value="all">{t('allTools')}</option><option value="none">{t('noTools')}</option><option value="selected">{t('selectedTools')}</option></select>{toolMode === 'selected' ? <><Label htmlFor="shared-allowed-tools">{t('toolNames')}</Label><Textarea id="shared-allowed-tools" value={allowedTools} disabled={disabled} onChange={event => setAllowedTools(event.target.value)} /></> : null}<p className="text-xs text-muted-foreground">{t('toolHint')}</p></div></details>
          <div className="space-y-2" data-testid="shared-grants">{grantList.map((grant, index) => <div key={`${grant.targetType}:${grant.targetId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
            <span className="min-w-0 break-words">{targetLabel(grant) || t('unknownTarget')} · {[grant.canUse ? t('canUse') : '', grant.canManage ? t('manage') : ''].filter(Boolean).join(', ')}</span>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setGrantList(current => current.filter((_, at) => at !== index))}>{t('remove')}</Button></div>)}</div>
          <div className="space-y-3 rounded-lg bg-muted/30 p-3">
            <Label htmlFor="shared-target-type">{t('grantTarget')}</Label><select id="shared-target-type" className={selectClass} value={targetType} disabled={disabled} onChange={event => { const type = event.target.value as typeof targetType; setTargetType(type); setTargetId(''); if (type === 'agent') setCanManage(false); }}>
              {(['user', 'workspace', 'project', 'role', 'organization', 'agent'] as const).map(type => <option key={type} value={type}>{t(`targets.${type}`)}</option>)}</select>
            <SearchablePolicyTargetPicker id="shared-grant-target" value={targetId} options={options} portalContainer={portal} label={t('grantTarget')}
              placeholder={t('chooseTarget')} searchPlaceholder={t('search')} emptyLabel={t('noTargets')} disabled={disabled} testId="shared-grant-target" onValueChange={setTargetId} />
            <div className="flex flex-wrap gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={canUse} disabled={disabled} onChange={event => setCanUse(event.target.checked)} />{t('canUse')}</label>
              {targetType !== 'agent' ? <label className="flex items-center gap-2"><input type="checkbox" checked={canManage} disabled={disabled} onChange={event => setCanManage(event.target.checked)} />{t('manage')}</label> : null}</div>
            <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('grantToolLimits')}</summary><Textarea aria-label={t('grantToolLimits')} value={grantTools} disabled={disabled} onChange={event => setGrantTools(event.target.value)} /></details>
            <Button type="button" size="sm" variant="outline" disabled={disabled || !targetId || (!canUse && !canManage)} onClick={() => {
              if (!options.some(value => value.id === targetId) || grantList.some(grant => grant.targetType === targetType && grant.targetId === targetId)) return;
              setGrantList(current => [...current, { targetType, targetId, canUse, canManage: targetType === 'agent' ? false : canManage, allowedToolNames: tools(grantTools) }]);
              setTargetId(''); setCanUse(false); setCanManage(false); setGrantTools('');
            }}>{t('addGrant')}</Button>
          </div>
          <div className="flex flex-wrap gap-2"><Button disabled={disabled || !name.trim()} onClick={() => void save()} data-testid="shared-connection-save">{busy ? t('saving') : t('save')}</Button>
            <Button variant="outline" disabled={disabled} onClick={() => void run(async () => { await api(path, { ...revisions(connection), status: connection.resource.status === 'active' ? 'archived' : 'active' }, 'PATCH'); if (alive.current && isCurrentSession(initial.resource.connectionRef)) onSaved(); })}>{t(connection.resource.status === 'active' ? 'archive' : 'restore')}</Button></div>
        </div>
      </details>
    </> : null}
  </div>;
}
