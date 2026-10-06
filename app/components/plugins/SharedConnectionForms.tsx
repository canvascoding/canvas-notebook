'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

const EMPTY_TARGETS: IntegrationConnectionTargetCatalog = { users: [], workspaces: [], projects: [], agents: [] };
const tools = (value: string): string[] | null => value.trim() ? [...new Set(value.split(/[\n,]/u).map(name => name.trim()).filter(Boolean))] : null;
const revisions = (value: IntegrationConnectionDescriptor) => ({ expectedMetadataRevision: value.resource.metadataRevision,
  expectedGrantsRevision: value.resource.grantsRevision, expectedBindingRevision: value.resource.bindingRevision });
const choice = (scope: IntegrationConnectionScopeChoice) => scope.ownership.type === 'team'
  ? { type: 'team' as const, workspaceId: scope.ownership.workspaceId } : { type: 'organization' as const };
const scopeQuery = (scope: IntegrationConnectionScopeChoice) => new URLSearchParams({ ownershipType: scope.ownership.type,
  ...(scope.ownership.type === 'team' ? { teamWorkspaceId: scope.ownership.workspaceId } : {}) });
const selectClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm';

export function SharedConnectionCreateForm({ api, scopes, onSaved }: {
  api: SharedConnectionApi; scopes: IntegrationConnectionScopeChoice[]; onSaved: () => void;
}) {
  const t = useTranslations('sharedConnections');
  const [scopeIndex, setScopeIndex] = useState(0), [source, setSource] = useState<'mcp' | 'composio'>('mcp');
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [token, setToken] = useState(''), [oauth, setOAuth] = useState(false);
  const [app, setApp] = useState(''), [profiles, setProfiles] = useState<Array<{ id: string; name: string; providerMode: string }>>([]);
  const [profileId, setProfileId] = useState(''), [profileName, setProfileName] = useState(''), [mode, setMode] = useState<'local' | 'managed'>('local');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const scope = scopes[scopeIndex], alive = useRef(true), request = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current += 1; }; }, []);
  const loadProfiles = useCallback(async () => {
    const current = ++request.current;
    setProfiles([]); setProfileId(''); setLoading(true); setError(null);
    try {
      const result = await api<{ profiles: Array<{ id: string; name: string; providerMode: string }> }>(`/api/composio/shared-profiles?${scopeQuery(scope)}`);
      if (alive.current && request.current === current) setProfiles(result.profiles);
    } catch { if (alive.current && request.current === current) setError(t('loadError')); }
    finally { if (alive.current && request.current === current) setLoading(false); }
  }, [api, scope, t]);
  useEffect(() => { if (source === 'composio') queueMicrotask(() => void loadProfiles()); }, [source, loadProfiles]);
  async function createProfile() {
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
    setBusy(true); setError(null);
    try {
      await api('/api/integrations/shared-connections', { displayName: name, ownership: choice(scope), source,
        ...(source === 'composio' ? { profileId, toolkit: app } : { config: { url, transport: 'http',
          ...(oauth ? { auth: 'oauth' } : {}), ...(token && !oauth ? { bearerTokenEnv: 'MCP_SLOT_TOKEN' } : {}) },
          secrets: token && !oauth ? [{ name: 'TOKEN', value: token }] : [] }) });
      if (alive.current) { setToken(''); onSaved(); }
    } catch (failure) { if (alive.current) setError(failure instanceof SharedConnectionRequestError && failure.code === 'setup_required'
      && profiles.find(profile => profile.id === profileId)?.providerMode === 'local' ? t('secretsRequired') : t('saveError')); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="space-y-4" data-testid="shared-connection-create-form">
    {error ? <InlineNotice variant="destructive" size="compact" actions={error === t('secretsRequired') ? <Link href="/settings?tab=secrets">{t('openSecrets')}</Link> : undefined}>{error}</InlineNotice> : null}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor="shared-owner">{t('owner')}</Label><select id="shared-owner" className={selectClass} value={scopeIndex} disabled={busy} onChange={event => setScopeIndex(Number(event.target.value))}>
        {scopes.map((entry, index) => <option key={index} value={index}>{entry.ownership.type === 'team' ? `${t('team')} · ${entry.label}` : t('organization')}</option>)}</select></div>
      <div className="space-y-1"><Label htmlFor="shared-source">{t('source')}</Label><select id="shared-source" className={selectClass} value={source} disabled={busy} onChange={event => setSource(event.target.value as 'mcp' | 'composio')}>
        <option value="mcp">{t('mcp')}</option><option value="composio">{t('composio')}</option></select></div>
    </div>
    <div className="space-y-1"><Label htmlFor="shared-name">{t('name')}</Label><Input id="shared-name" value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)} /></div>
    {source === 'mcp' ? <>
      <div className="space-y-1"><Label htmlFor="shared-url">{t('endpoint')}</Label><Input id="shared-url" type="url" value={url} disabled={busy} placeholder="https://…" onChange={event => setUrl(event.target.value)} /></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={oauth} disabled={busy} onChange={event => { setOAuth(event.target.checked); setToken(''); }} />{t('oauth')}</label>
      {!oauth ? <div className="space-y-1"><Label htmlFor="shared-token">{t('token')}</Label><Input id="shared-token" type="password" autoComplete="new-password" value={token} disabled={busy} onChange={event => setToken(event.target.value)} /><p className="text-xs text-muted-foreground">{t('tokenHint')}</p></div> : null}
    </> : <>
      <div className="space-y-1"><Label htmlFor="shared-profile">{t('profile')}</Label><select id="shared-profile" className={selectClass} value={profileId} disabled={busy || loading} onChange={event => setProfileId(event.target.value)}>
        <option value="">{t('chooseProfile')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></div>
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('newProfile')}</summary><div className="mt-3 space-y-3">
        <Label htmlFor="shared-profile-name">{t('profileName')}</Label><Input id="shared-profile-name" value={profileName} maxLength={80} disabled={busy || loading} onChange={event => setProfileName(event.target.value)} />
        <Label htmlFor="shared-profile-mode">{t('accessSource')}</Label><select id="shared-profile-mode" className={selectClass} value={mode} disabled={busy} onChange={event => setMode(event.target.value as 'local' | 'managed')}>
          <option value="local">{t('localMode')}</option><option value="managed">{t('managedMode')}</option></select>
        <p className="text-xs text-muted-foreground">{t('profileHint')}</p><Button type="button" variant="outline" onClick={() => void createProfile()} disabled={busy || loading || !profileName.trim()}>{t('createProfile')}</Button>
      </div></details>
      <div className="space-y-1"><Label htmlFor="shared-app">{t('app')}</Label><Input id="shared-app" value={app} maxLength={100} placeholder="canva" disabled={busy} onChange={event => setApp(event.target.value)} /></div>
    </>}
    <p className="text-xs leading-5 text-muted-foreground">{t('restrictedDefault')}</p>
    <Button className="w-full sm:w-auto" onClick={() => void create()} disabled={busy || loading || !name.trim() || (source === 'mcp' ? !url.trim() : !profileId || !app.trim())}>{busy ? t('saving') : t('create')}</Button>
  </div>;
}

export function SharedConnectionEditor({ api, initial, onSaved }: {
  api: SharedConnectionApi; initial: IntegrationConnectionDescriptor; onSaved: () => void;
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
  const [repairConfiguration, setRepairConfiguration] = useState(''), [repairSecrets, setRepairSecrets] = useState('');
  const path = `/api/integrations/shared-connections/${encodeURIComponent(initial.resource.connectionRef)}`;
  const providerPath = `/api/${initial.resource.source}/shared-connections/${encodeURIComponent(initial.resource.connectionRef)}`;
  const load = useCallback(async () => {
    setLoading(true); setReady(false); setError(null); setAccounts([]); setAccountRef(''); setStatus(null); setTargets(EMPTY_TARGETS);
    try {
      const value = (await api<{ connection: IntegrationConnectionDescriptor }>(path)).connection;
      if (!alive.current) return;
      setConnection(value); setName(value.resource.displayName); setDescription(value.resource.description || ''); setResponsible(value.resource.responsibleUserId || '');
      setAccessMode(value.resource.accessMode); setAllowedTools((value.resource.allowedToolNames || []).join('\n'));
      setToolMode(value.resource.allowedToolNames === null ? 'all' : value.resource.allowedToolNames.length ? 'selected' : 'none');
      setGrantList((value.grants || []).map(({ targetType, targetId, canUse, canManage, allowedToolNames }) => ({ targetType, targetId, canUse, canManage, allowedToolNames })));
      if (value.access.canManage) {
        const result = await api<{ targets: IntegrationConnectionTargetCatalog }>(`${path}/targets`);
        if (alive.current) setTargets(result.targets);
      }
      if (alive.current) setReady(true);
    } catch { if (alive.current) setError(t('loadError')); }
    finally { if (alive.current) setLoading(false); }
  }, [api, path, t]);
  useEffect(() => { alive.current = true; queueMicrotask(() => void load()); return () => { alive.current = false; }; }, [load]);
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
  const disabled = loading || busy || conflict || !ready;
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await operation(); }
    catch (failure) { if (alive.current) { const stale = failure instanceof SharedConnectionRequestError && failure.status === 409; setConflict(stale); setError(t(stale ? 'conflict' : 'saveError')); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    await run(async () => {
      await api(path, { ...revisions(connection), metadata: { displayName: name, description, responsibleUserId: responsible || null },
        grants: grantList, accessMode, allowedToolNames: toolMode === 'all' ? null : toolMode === 'none' ? [] : tools(allowedTools) ?? [] }, 'PATCH');
      if (alive.current) onSaved();
    });
  }
  async function authorize() {
    await run(async () => {
      const result = await api<{ redirectUrl?: string | null; authorizationUrl?: string }>(`${providerPath}/${connection.resource.source === 'mcp' ? 'oauth' : 'connect'}`, revisions(connection));
      if (!alive.current) return;
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
      if (alive.current) { setAccounts(result.accounts); setAccountRef(''); }
    });
  }
  return <div ref={setPortal} className="space-y-4" data-testid="shared-connection-editor">
    <p className="text-sm text-muted-foreground">{connection.resource.description || t('separateAccountHint')}</p>
    <p className="text-xs text-muted-foreground">{connection.access.canUse ? t('canUse') : t('managementOnly')}</p>
    {error ? <InlineNotice variant="destructive" size="compact">{error}</InlineNotice> : null}
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setConflict(false); void load(); }}>{t('reload')}</Button>
    {connection.access.canManage ? <>
      <details className="space-y-3 rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">{t('accountSetup')}</summary>
        <div className="space-y-3 pt-3">
          <p className="text-xs text-muted-foreground">{t('accountHint')}</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled} onClick={() => void authorize()}>{t('connect')}</Button>
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run(async () => {
              const result = await api<{ status?: { connected: boolean }; authorized?: boolean; requiresAuth?: boolean }>(`${providerPath}/${connection.resource.source === 'mcp' ? 'oauth' : 'status'}`);
              if (alive.current) setStatus(t(result.status?.connected || result.authorized || result.requiresAuth === false ? 'connected' : 'connectionRequired'));
            })}>{t('checkStatus')}</Button>
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run(async () => {
              await api(`${providerPath}/${connection.resource.source === 'mcp' ? 'oauth' : 'disconnect'}`, revisions(connection), connection.resource.source === 'mcp' ? 'DELETE' : 'POST');
              if (alive.current) await load();
            })}>{t('disconnect')}</Button></div>
          {status ? <p className="text-sm">{status}</p> : null}
          {connection.resource.source === 'composio' ? <><Button size="sm" variant="outline" disabled={disabled} onClick={() => void loadAccounts()}>{t('loadAccounts')}</Button>
            {accounts.length ? <div className="space-y-2"><Label htmlFor="shared-account">{t('account')}</Label><select id="shared-account" className={selectClass} value={accountRef} disabled={disabled} onChange={event => setAccountRef(event.target.value)}>
              <option value="">{t('chooseAccount')}</option>{accounts.map(account => <option key={account.accountRef} value={account.accountRef} disabled={!account.selectable}>{account.label}</option>)}</select>
              <Button size="sm" disabled={disabled || !accountRef} onClick={() => void run(async () => { await api(`${providerPath}/accounts`, { ...revisions(connection), accountRef }, 'PATCH'); if (alive.current) await load(); })}>{t('bindAccount')}</Button></div> : null}</> : null}
          {connection.resource.source === 'mcp' ? <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm">{t('repairSetup')}</summary><div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">{t('repairHint')}</p><Label htmlFor="shared-repair-config">{t('configuration')}</Label><Textarea id="shared-repair-config" className="font-mono text-xs" value={repairConfiguration} disabled={disabled} onChange={event => setRepairConfiguration(event.target.value)} placeholder={'{"url":"https://…","transport":"http"}'} />
            <Label htmlFor="shared-repair-secrets">{t('secretSlots')}</Label><Textarea id="shared-repair-secrets" className="font-mono text-xs" value={repairSecrets} disabled={disabled} onChange={event => setRepairSecrets(event.target.value)} placeholder={'[{"name":"TOKEN","value":"…"}]'} />
            <Button size="sm" variant="outline" disabled={disabled || !repairConfiguration.trim()} onClick={() => void run(async () => {
              const config: unknown = JSON.parse(repairConfiguration), secrets: unknown = repairSecrets.trim() ? JSON.parse(repairSecrets) : [];
              await api(`${providerPath}/configuration`, { ...revisions(connection), config, secrets }, 'PUT');
              if (alive.current) { setRepairSecrets(''); await load(); }
            })}>{t('saveSetup')}</Button>
          </div></details> : null}
        </div>
      </details>
      <details className="space-y-3 rounded-lg border p-3" open><summary className="cursor-pointer text-sm font-medium">{t('metadataAndGrants')}</summary>
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
          <div className="flex flex-wrap gap-2"><Button disabled={disabled || !name.trim()} onClick={() => void save()}>{busy ? t('saving') : t('save')}</Button>
            <Button variant="outline" disabled={disabled} onClick={() => void run(async () => { await api(path, { ...revisions(connection), status: connection.resource.status === 'active' ? 'archived' : 'active' }, 'PATCH'); if (alive.current) onSaved(); })}>{t(connection.resource.status === 'active' ? 'archive' : 'restore')}</Button></div>
        </div>
      </details>
    </> : null}
  </div>;
}
