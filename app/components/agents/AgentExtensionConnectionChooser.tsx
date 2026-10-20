'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, ExternalLink, Loader2, Search } from 'lucide-react';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { standaloneExtensionSelectionSchema, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionConnectionChoice, AgentExtensionConnectionSelector, AgentExtensionOptionsResponse,
  AgentExtensionOptionsTarget, AgentExtensionPackageBinding } from '@/app/lib/agents/extension-options-contracts';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import type { AgentExtensionEditorContext } from './AgentExtensionEditor';
import { agentExtensionEditorContextKey, requestAgentExtensionOptions } from './agent-extension-options-client';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';
import { WorkflowCheckbox } from './WorkflowCheckbox';
import { AgentExtensionRequestErrorNotice } from './AgentExtensionRequestErrorNotice';
import { buildAgentExtensionSetupLinks } from './agent-extension-setup-links';

export type AgentExtensionChosenConnection = { selection: StandaloneExtensionSelection; accountSelectionRef?: string;
  accountSelectionExpiresAt?: string;
  packageBinding?: AgentExtensionPackageBinding; choiceId?: string; label: string };
export type AgentExtensionConnectionChoices = Extract<AgentExtensionOptionsResponse, { operation: 'connection_choices' }>;
export type AgentExtensionConnectionChooserProps = { target: AgentExtensionOptionsTarget; context: AgentExtensionEditorContext;
  selector: AgentExtensionConnectionSelector; disabled?: boolean;
  onSelect: (choice: AgentExtensionChosenConnection) => void | Promise<void>;
  onMetadata?: (metadata: AgentExtensionConnectionChoices) => void;
  /** Kept for source compatibility; setup navigation comes only from current server alternatives. */
  setupHref?: string };

export type ExtensionConnectionChooserData = Pick<AgentExtensionConnectionChoices,
  'connections' | 'profiles' | 'accounts' | 'pagination' | 'setupAlternatives' | 'noAuthSelection' | 'noAuthPackageBinding' | 'contextKey'>;
export type ExtensionConnectionChooserQuery = { q: string; profileId?: string; cursor: string | null; limit: number };
export type ExtensionConnectionChooserProvider<TData extends ExtensionConnectionChooserData = ExtensionConnectionChooserData> = {
  /** Actual target, selector and signed-in scope. A changed key creates a fresh chooser session. */
  key: string; workspaceId: string | null; purpose: 'chat' | 'agent';
  load: (query: ExtensionConnectionChooserQuery, signal: AbortSignal) => Promise<TData>;
};
export type ExtensionConnectionChooserProps<TData extends ExtensionConnectionChooserData = ExtensionConnectionChooserData> = {
  provider: ExtensionConnectionChooserProvider<TData>; disabled?: boolean;
  onSelect: (choice: AgentExtensionChosenConnection) => void | Promise<void>;
  onMetadata?: (metadata: TData) => void;
  /** Renewal must deliberately select the identical public account/connection, not a fallback. */
  lockedSelection?: StandaloneExtensionSelection;
};
function sameConnectionSelection(left: StandaloneExtensionSelection, right: StandaloneExtensionSelection): boolean {
  return JSON.stringify(standaloneExtensionSelectionSchema.parse(left)) === JSON.stringify(standaloneExtensionSelectionSchema.parse(right));
}

/** Only a deliberate profile click requests account enumeration; identities always come from the service. */
export function AgentExtensionConnectionChooser(props: AgentExtensionConnectionChooserProps) {
  const key = agentExtensionEditorContextKey(props.context, props.target) + JSON.stringify(props.selector);
  const { target, context, selector } = props;
  const provider: ExtensionConnectionChooserProvider<AgentExtensionConnectionChoices> = {
    key, workspaceId: context.workspaceId, purpose: 'agent',
    load: async (query, signal) => {
      const common = { operation: 'connection_choices' as const, ...query };
      const request = target.kind === 'user_choice' && selector.kind === 'slot' ? { ...common, target, selector }
        : target.kind !== 'user_choice' && selector.kind !== 'slot' ? { ...common, target, selector } : null;
      if (!request) throw new Error('Target and selector do not match.');
      return requestAgentExtensionOptions(context, request, signal);
    },
  };
  return <ExtensionConnectionChooser provider={provider} disabled={props.disabled} onSelect={props.onSelect} onMetadata={props.onMetadata} />;
}

/** Shared interaction only: each caller supplies its own genuine scoped metadata service. */
export function ExtensionConnectionChooser<TData extends ExtensionConnectionChooserData = ExtensionConnectionChooserData>(props: ExtensionConnectionChooserProps<TData>) {
  return <ConnectionChooserSession key={JSON.stringify([props.provider.key, props.provider.workspaceId, props.provider.purpose, props.lockedSelection ?? null])} {...props} />;
}
function ConnectionChooserSession<TData extends ExtensionConnectionChooserData>({ provider, disabled, onSelect, onMetadata, lockedSelection }: ExtensionConnectionChooserProps<TData>) {
  const copy = useAgentExtensionCopy(), locale = useLocale();
  const [query, setQuery] = useState(''), [profileId, setProfileId] = useState<string>();
  const [profileQuery, setProfileQuery] = useState('');
  const [data, setData] = useState<TData | null>(null), [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [selecting, setSelecting] = useState(false);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const key = provider.key;
  const epoch = useRef(0), contextKey = useRef<string | null>(null), alive = useRef(true), selectionPending = useRef(false);
  const metadataCallback = useRef(onMetadata);
  useLayoutEffect(() => { metadataCallback.current = onMetadata; }, [onMetadata]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(), version = ++epoch.current;
    queueMicrotask(() => { if (!controller.signal.aborted) { setPending(true); setError(null); } });
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => provider.load({ ...(profileId === undefined ? {} : { profileId }), q: query, cursor, limit: 20 }, controller.signal)).then(result => {
        if (controller.signal.aborted || epoch.current !== version) return;
        if (cursor && contextKey.current !== result.contextKey) throw new Error(copy('Der Kontext wurde geändert. Bitte erneut laden.', 'The context changed. Reload the choices.'));
        contextKey.current = result.contextKey;
        setData(previous => cursor && previous ? { ...result,
          connections: [...previous.connections, ...result.connections.filter(row => !previous.connections.some(old => old.id === row.id))],
          profiles: [...previous.profiles, ...result.profiles.filter(row => !previous.profiles.some(old => old.profileId === row.profileId))],
          accounts: [...previous.accounts, ...result.accounts.filter(row => !previous.accounts.some(old => JSON.stringify(old.selection) === JSON.stringify(row.selection)))],
        } : result);
        metadataCallback.current?.(result);
      }).catch(reason => { if (!controller.signal.aborted && epoch.current === version) setError(reason instanceof Error ? reason : new Error(String(reason))); })
        .finally(() => { if (!controller.signal.aborted && epoch.current === version) setPending(false); });
    }, query ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // The provider key captures its genuine scoped target; callbacks never restart account enumeration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, query, profileId, cursor, refresh]);
  const selectionMatches = (selection: StandaloneExtensionSelection) => !lockedSelection || sameConnectionSelection(lockedSelection, selection);
  const profileMatches = (id: string) => !lockedSelection || lockedSelection.kind === 'composio' && lockedSelection.target.kind === 'personal' && lockedSelection.target.profileId === id;
  const choose = async (choice: AgentExtensionChosenConnection) => {
    if (disabled || selectionPending.current || pending || error || !alive.current || !selectionMatches(choice.selection)) return;
    selectionPending.current = true;
    setSelecting(true); setError(null);
    try { await onSelect(choice); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason : new Error(String(reason))); }
    finally { selectionPending.current = false; if (alive.current) setSelecting(false); }
  };
  const chooseConnection = (row: AgentExtensionConnectionChoice) => choose({ selection: row.selection, label: row.label,
    ...(row.packageBinding ? { packageBinding: row.mappingRequired && confirmed.has(row.id) && row.packageBinding.target.kind === 'shared'
      ? { ...row.packageBinding, target: { ...row.packageBinding.target, mcpMapping: { kind: 'manager_confirmation' as const } } }
      : row.packageBinding } : {}), ...(row.choiceId ? { choiceId: row.choiceId } : {}) });
  const busy = Boolean(disabled || selecting);
  const selectionDisabled = busy || pending || Boolean(error);
  const setupLinks = !pending && !error && data ? buildAgentExtensionSetupLinks({ alternatives: data.setupAlternatives ?? [], workspaceId: provider.workspaceId, locale }) : [];
  return <div className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="agent-extension-connection-chooser">
    <div className="flex items-center gap-2">
      {profileId ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
        setProfileId(undefined); setCursor(null); setQuery(profileQuery); setData(null); contextKey.current = null;
      }}><ArrowLeft className="size-3.5" />{copy('Profile', 'Profiles')}</Button> : null}
      <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" aria-label={copy('Verbindungen durchsuchen', 'Search connections')} placeholder={profileId ? copy('Konten filtern', 'Filter accounts') : copy('Verbindungen filtern', 'Filter connections')}
          value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setCursor(null); setData(null); }} /></div>
    </div>
    <p className="text-xs text-muted-foreground">{profileId ? copy('Wähle das genaue Konto. Die Auswahl wird beim Speichern erneut geprüft.', 'Choose the exact account. Saving checks this choice again.')
      : copy('Verbindung auswählen. Persönliche Konten werden erst nach Auswahl eines Profils geladen.', 'Choose a connection. Personal accounts load after you choose a profile.')}</p>
    {lockedSelection ? <p className="text-xs text-muted-foreground">{copy('Bestätige dieselbe Verbindung erneut. Andere Konten sind hier nicht auswählbar.', 'Confirm the same connection again. Other accounts cannot be selected here.')}</p> : null}
    {error ? <div className="space-y-2"><AgentExtensionRequestErrorNotice error={error} /><Button type="button" size="sm" variant="outline" disabled={busy || pending} onClick={() => { setCursor(null); setRefresh(value => value + 1); }}>{copy('Erneut laden', 'Reload')}</Button></div> : null}
    <div className="max-h-72 space-y-2 overflow-y-auto">
      {!profileId && data?.connections.map(row => <div className="rounded-md border bg-background p-2.5" key={row.id}>
        <div className="flex items-center gap-2.5"><PluginExtensionAvatar size="sm" name={row.label} identity={`${key}:${row.id}`} icon={row.icon} />
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{row.label}</p><p className="text-xs text-muted-foreground">{[row.profileLabel, row.ownershipLabel,
            row.scopeLabel === 'personal' ? copy('Persönlich', 'Personal') : row.scopeLabel === 'team' ? copy('Team', 'Team') : copy('Organisation', 'Organization')].filter(Boolean).join(' · ')}</p></div>
          <Button type="button" size="sm" variant="outline" disabled={selectionDisabled || !selectionMatches(row.selection) || row.eligibility.action !== 'select' || row.mappingRequired && !confirmed.has(row.id)}
            onClick={() => void chooseConnection(row)}><Check className="size-3.5" />{copy('Wählen', 'Choose')}</Button></div>
        {row.eligibility.reason ? <p className="mt-1.5 text-xs text-muted-foreground">{row.eligibility.reason.message}</p> : null}
        {row.mappingRequired ? <label className="mt-2 flex items-start gap-2 text-xs"><WorkflowCheckbox checked={confirmed.has(row.id)} disabled={selectionDisabled}
          onCheckedChange={checked => setConfirmed(previous => { const next = new Set(previous); if (checked) next.add(row.id); else next.delete(row.id); return next; })} />
          {copy('Ich bestätige, dass diese MCP-Verbindung zum angeforderten Connector gehört.', 'I confirm that this MCP connection matches the requested connector.')}</label> : null}
      </div>)}
      {!profileId && data?.profiles.map(profile => <button type="button" key={profile.profileId} disabled={selectionDisabled || !profileMatches(profile.profileId)}
        className="flex w-full items-center gap-3 rounded-md border bg-background p-3 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={() => { setProfileQuery(query); setData(null); setCursor(null); setQuery(''); setProfileId(profile.profileId); contextKey.current = null; }}>
        <PluginExtensionAvatar size="sm" name={profile.label} identity={`${key}:${profile.profileId}`} /><span className="min-w-0 flex-1 truncate">{profile.label}<span className="mt-0.5 block text-xs text-muted-foreground">{copy('Konten anzeigen', 'Show accounts')}</span></span><ChevronRight className="size-4 text-muted-foreground" />
      </button>)}
      {profileId && data?.accounts.map(account => <div className="flex items-center gap-3 rounded-md border bg-background p-3" key={JSON.stringify(account.selection)}>
        <PluginExtensionAvatar size="sm" name={account.label} identity={`${key}:${JSON.stringify(account.selection)}`} />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{account.label}</p><p className="text-xs text-muted-foreground">{account.status}</p></div>
        <Button type="button" size="sm" variant="outline" disabled={selectionDisabled || !account.selectable || !selectionMatches(account.selection)} onClick={() => void choose({ selection: account.selection,
          label: account.label, accountSelectionRef: account.accountSelectionRef,
          ...(account.expiresAt ? { accountSelectionExpiresAt: account.expiresAt } : {}),
          ...(account.packageBinding ? { packageBinding: account.packageBinding } : {}) })}>{copy('Dieses Konto', 'This account')}</Button>
      </div>)}
      {data?.noAuthSelection ? <Button type="button" variant="outline" className="w-full justify-start" disabled={selectionDisabled || !selectionMatches(data.noAuthSelection)} onClick={() => void choose({
        selection: data.noAuthSelection!, label: copy('Ohne Anmeldung', 'No sign-in'), ...(data.noAuthPackageBinding ? { packageBinding: data.noAuthPackageBinding } : {}) })}>{copy('Ohne Anmeldung verwenden', 'Use without sign-in')}</Button> : null}
    </div>
    {pending ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{copy('Wird geladen …', 'Loading…')}</p> : null}
    {!pending && data && !(profileId ? data.accounts.length || data.noAuthSelection : data.connections.length || data.profiles.length || data.noAuthSelection) ? <p className="py-3 text-center text-sm text-muted-foreground">{copy('Keine passende Verbindung gefunden.', 'No matching connection found.')}</p> : null}
    {data?.pagination.hasNextPage ? <Button type="button" variant="ghost" size="sm" disabled={busy || pending} onClick={() => setCursor(data.pagination.nextCursor)}>{copy('Weitere laden', 'Load more')}</Button> : null}
    {setupLinks.length ? <div className="space-y-2 border-t pt-3" data-testid="agent-extension-setup-links"><p className="text-xs text-muted-foreground">{copy('Fehlt eine Verbindung?', 'Missing a connection?')}</p>
      {setupLinks.map(link => <a key={link.key} href={link.href} target="_blank" rel="noopener noreferrer"
        className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0"><span className="block truncate font-medium">{link.label}</span><span className="block truncate text-xs text-muted-foreground">{link.source === 'composio' ? 'Composio' : link.connector ? `MCP · ${link.connector}` : 'MCP'}</span></span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs">{copy('Einrichten', 'Set up')}<ExternalLink className="size-3" /></span></a>)}
      <p className="text-xs text-muted-foreground">{provider.purpose === 'chat'
        ? copy('Dein Nachrichtenentwurf bleibt hier erhalten. Danach aktualisieren und die genaue Verbindung ausdrücklich wählen.', 'Your message draft stays here. Afterwards refresh and explicitly choose the exact connection.')
        : copy('Der Agent-Entwurf bleibt erhalten. Danach aktualisieren und die genaue Verbindung ausdrücklich wählen.', 'Your agent draft stays here. Afterwards refresh and explicitly choose the exact connection.')}</p>
    </div> : null}
    <Button type="button" size="sm" variant="ghost" disabled={busy || pending} onClick={() => { setCursor(null); setData(null); setRefresh(value => value + 1); }}>{copy('Nach Einrichtung aktualisieren', 'Refresh after setup')}</Button>
  </div>;
}
