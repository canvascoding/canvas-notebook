'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authClient } from '@/app/lib/auth-client';
import type { CapabilityPackageMcpTemplate } from '@/app/lib/capabilities/packages/presentation-contracts';
import type { IntegrationConnectionDescriptor, IntegrationConnectionScopeChoice } from '@/app/lib/integration-tools/connections/contracts';
import type { PluginExtensionItem } from '@/app/lib/plugins/plugin-extension-contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { InlineNotice } from '@/components/ui/inline-notice';
import { McpServerDialog, createBlankMcpServerDraft, createMcpServerDraftFromConnector, parseMcpConfigFile, toMcpServerDraft, type McpServerDraft } from '@/app/components/settings/McpServerDialog';
import { savePersonalMcpServer } from '@/app/components/settings/mcp-setup-client';
import { SharedConnectionCreateForm } from './SharedConnectionForms';
import { pluginIntegrationRequest, usePluginSharedConnectionApi } from './plugin-integration-client';
import { usePluginEditorNavigationGuard } from './plugin-navigation-guard';

export type PluginMcpCreated = {kind: 'mcp'; id: string; connectionRef?: string};
export type PluginMcpSetupProps = {workspaceId: string | null; item?: Extract<PluginExtensionItem, {kind: 'mcp'}>;
  template?: CapabilityPackageMcpTemplate; onCreated: (result: PluginMcpCreated) => void; onClose: () => void; returnPath: string};
type Definition = {id: string; name: string; enabled: boolean; config: Record<string, unknown>};
const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
const scopeKey = (scope: IntegrationConnectionScopeChoice) => scope.ownership.type === 'team' ? `team:${scope.ownership.workspaceId}` : 'organization';

export function PluginMcpSetup(props: PluginMcpSetupProps) {
  const {data: session, isPending, error} = authClient.useSession();
  return <PluginMcpSetupSession key={JSON.stringify([session?.user.id, session?.session.id, props.workspaceId, props.item?.id, props.template?.resourceRef, props.template?.source.checksum])}
    {...props} actorId={session?.user.id ?? null} sessionId={session?.session.id ?? null} enabled={Boolean(session && !isPending && !error)} />;
}

function PluginMcpSetupSession({workspaceId, item, template, onCreated, onClose, actorId, sessionId, enabled}: PluginMcpSetupProps & {
  actorId: string | null; sessionId: string | null; enabled: boolean;
}) {
  const t = useTranslations('skills.workspace.setup'), alive = useRef(true), generation = useRef(0), read = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState<PluginMcpCreated | null>(null);
  const [canManage, setCanManage] = useState(false), [scopes, setScopes] = useState<IntegrationConnectionScopeChoice[]>([]), [scope, setScope] = useState('');
  const [definitions, setDefinitions] = useState<Definition[]>([]), [definitionId, setDefinitionId] = useState(item?.mcp.definitionId || '');
  const [name, setName] = useState(''), [rawContent, setRawContent] = useState('{}'), [dialog, setDialog] = useState(false);
  const [draft, setDraft] = useState<McpServerDraft>(() => template ? createMcpServerDraftFromConnector(template.connector, template.config) : createBlankMcpServerDraft());
  const isCurrent = useCallback(() => { const current = authClient.$store.atoms.session.get(); return alive.current && enabled
    && !current.isPending && !current.error && current.data?.user.id === actorId && current.data?.session.id === sessionId; }, [actorId, sessionId, enabled]);
  const api = usePluginSharedConnectionApi(workspaceId, isCurrent, setPending);
  usePluginEditorNavigationGuard({dirty: !completed && (dialog || name !== ''), pending});
  const reported = useRef(false);
  useEffect(() => { if (completed && !pending && !reported.current) { reported.current = true; onCreated(completed); } }, [completed, pending, onCreated]);
  const load = useCallback(async () => {
    if (!isCurrent()) return;
    read.current?.abort(); const controller = new AbortController(), attempt = ++generation.current; read.current = controller;
    setLoading(true); setError(null);
    try {
      const [approved, shared] = await Promise.all([
        pluginIntegrationRequest<{canManageDefinitions: boolean; definitions: Definition[]}>('/api/integrations/mcp-definitions', workspaceId, {signal: controller.signal}),
        api<{scopes: IntegrationConnectionScopeChoice[]}>('/api/integrations/shared-connections/setup'),
      ]);
      if (!isCurrent() || attempt !== generation.current) return;
      setCanManage(approved.canManageDefinitions); setDefinitions(approved.definitions.filter(value => value.enabled)); setScopes(shared.scopes);
      const selectedScope = item?.ownership?.type === 'organization' || item?.ownership?.type === 'team'
        ? scopeKey({ownership: item.ownership, label: null}) : item?.mcp.serverId || item?.mcp.definitionId ? 'user' : shared.scopes.length ? '' : 'user';
      setScope(selectedScope);
      if (approved.canManageDefinitions) {
        const config = await pluginIntegrationRequest<{rawContent: string}>('/api/integrations/mcp-config', workspaceId, {signal: controller.signal});
        if (!isCurrent() || attempt !== generation.current) return;
        setRawContent(config.rawContent);
        if (item?.mcp.serverId) {
          const found = Object.entries(parseMcpConfigFile(config.rawContent).mcpServers).find(([, value]) => value.connectionId === item.mcp.serverId);
          if (!found) throw new Error('connection_changed');
          setDraft(toMcpServerDraft(found[0], found[1]));
        }
      }
    } catch { if (isCurrent() && attempt === generation.current && !controller.signal.aborted) setError(t('loadError')); }
    finally { if (isCurrent() && attempt === generation.current) setLoading(false); }
  }, [api, isCurrent, item, t, workspaceId]);
  useEffect(() => { alive.current = true; queueMicrotask(() => void load()); return () => { alive.current = false; generation.current += 1; read.current?.abort(); }; }, [load]);
  async function save() {
    if (!isCurrent() || pending || !canManage) return;
    setPending(true); setError(null);
    try {
      const result = await savePersonalMcpServer({rawContent, draft, originalName: item?.mcp.serverId ? draft.originalServerName : undefined,
        envError: t('saveError'), saveError: t('saveError'), workspaceId, isCurrent});
      if (!isCurrent()) return;
      const id = parseMcpConfigFile(result.rawContent).mcpServers[draft.name.trim()]?.connectionId;
      if (typeof id !== 'string' || !id) throw new Error('connection_missing');
      setDialog(false); setName(''); setCompleted({kind: 'mcp', id: `mcp-personal:${id}`});
    } catch { if (isCurrent()) setError(t('saveError')); }
    finally { if (isCurrent()) setPending(false); }
  }
  async function connectDefinition() {
    if (!isCurrent() || pending || !definitions.some(value => value.id === definitionId)) return;
    setPending(true); setError(null);
    try {
      const result = await pluginIntegrationRequest<{connectionId: string}>('/api/integrations/mcp-connections', workspaceId, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'connect', definitionId, displayName: name})});
      if (isCurrent()) { setName(''); setCompleted({kind: 'mcp', id: `mcp-personal:${result.connectionId}`}); }
    } catch { if (isCurrent()) setError(t('saveError')); }
    finally { if (isCurrent()) setPending(false); }
  }
  const chosen = scopes.find(value => scopeKey(value) === scope);
  const sharedCreated = (connection: IntegrationConnectionDescriptor) => setCompleted({kind: 'mcp', id: connection.resource.connectionRef, connectionRef: connection.resource.connectionRef});
  return <section className="min-w-0 space-y-5" data-testid="plugin-mcp-setup">
    <header><Button variant="ghost" onClick={onClose}>{t('back')}</Button><h2 className="mt-3 text-xl font-semibold">{t('mcpTitle')}</h2><p className="mt-2 text-sm text-muted-foreground">{t('mcpDescription')}</p></header>
    {error ? <InlineNotice variant="destructive" size="compact">{error}</InlineNotice> : null}
    {loading ? <p role="status">{t('loading')}</p> : <>
      <div className="max-w-xl space-y-2"><Label htmlFor="plugin-mcp-scope">{t('scope')}</Label><select id="plugin-mcp-scope" className={selectClass} value={scope} disabled={pending} onChange={event => setScope(event.target.value)}>
        <option value="">{t('selectScope')}</option><option value="user">{t('personal')}</option>{scopes.map(value => <option key={scopeKey(value)} value={scopeKey(value)}>{value.ownership.type === 'team' ? value.label || t('shared') : t('shared')} · {value.ownership.type}</option>)}</select></div>
      {template?.redactedFields.length ? <InlineNotice size="compact">{t('templateRedacted')}</InlineNotice> : null}
      {scope === 'user' ? <div className="max-w-xl space-y-4">
        {canManage ? <Button disabled={pending} onClick={() => setDialog(true)} data-testid="plugin-mcp-add-personal">{t(item?.mcp.serverId ? 'manage' : 'continueSetup')}</Button> : <InlineNotice size="compact">{t('mcpRestricted')}</InlineNotice>}
        {!canManage || item?.mcp.definitionId ? <div className="space-y-3"><Label htmlFor="plugin-mcp-definition">{t('definition')}</Label><select id="plugin-mcp-definition" className={selectClass} value={definitionId} disabled={pending} onChange={event => setDefinitionId(event.target.value)}><option value="">{t('selectConnection')}</option>{definitions.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>
          <Label htmlFor="plugin-mcp-name">{t('name')}</Label><Input id="plugin-mcp-name" value={name} maxLength={120} disabled={pending} onChange={event => setName(event.target.value)} />
          <Button disabled={pending || !definitionId || !name.trim()} onClick={() => void connectDefinition()} data-testid="plugin-mcp-definition-connect">{t('connect')}</Button></div> : null}
      </div> : chosen ? <SharedConnectionCreateForm key={scope} api={api} scopes={[chosen]} initialSource="mcp" lockSource compact initialName={template?.connector.label || template?.connector.name}
        initialConfig={template?.config} onSaved={() => undefined} onCreated={sharedCreated} /> : null}
    </>}
    <McpServerDialog open={dialog} onOpenChange={setDialog} draft={draft} onDraftChange={patch => setDraft(value => ({...value, ...patch}))}
      onSave={() => void save()} editingServerName={item?.mcp.serverId ? draft.originalServerName : undefined} isSaving={pending} error={error} developerMode />
  </section>;
}
