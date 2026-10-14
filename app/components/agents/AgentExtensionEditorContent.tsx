'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ExternalLink, Loader2, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import { agentExtensionConfigurationInputSchema, extensionSelectionIdentity, type AgentStandaloneConfigurationInput,
  type ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionOptionsResponse, AgentExtensionPackageVersion, AgentExtensionSearchItem,
  AgentExtensionSearchRequest } from '@/app/lib/agents/extension-options-contracts';
import type { AgentExtensionEditorDraft, AgentExtensionEditorProps, AgentExtensionEditorValidation } from './AgentExtensionEditor';
import { agentExtensionStandalonePresentationKey } from '@/app/lib/agents/extension-presentation-contracts';
import { AgentExtensionConnectionChooser, type AgentExtensionChosenConnection } from './AgentExtensionConnectionChooser';
import { AgentExtensionPackageEditor } from './AgentExtensionPackageEditor';
import { AgentExtensionStandaloneEditor, type AgentExtensionConnectionPresentation } from './AgentExtensionStandaloneEditor';
import { agentExtensionSelectClass } from './AgentExtensionToolCapEditor';
import { addExtensionPackage, clearAgentExtensionDraft, emptyAgentExtensionConfiguration, extensionPinKey,
  readAgentExtensionDraft, saveAgentExtensionDraft, type FixedAgentExtensionConfiguration } from './agent-extension-editor-draft';
import { agentExtensionEditorContextKey, requestAgentExtensionOptions } from './agent-extension-options-client';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';
import { WorkflowCheckbox } from './WorkflowCheckbox';

type SearchData = Extract<AgentExtensionOptionsResponse, { operation: 'search' }>;
type Filters = Pick<AgentExtensionSearchRequest, 'types' | 'stock' | 'source' | 'scope' | 'audience' | 'teamId'>;
const initialFilters: Filters = { types: ['plugin', 'skill', 'integration', 'mcp'], stock: 'all', source: 'all', scope: 'all', audience: null, teamId: null };

export function AgentExtensionEditorContent(props: AgentExtensionEditorProps) {
  return <EditorSession key={agentExtensionEditorContextKey(props.context, props.target)} {...props} />;
}
function EditorSession({ target, context, value, onChange, enabledTools, model, disabled, onValidationChange, suggestedSkillNames, bindingSummaries, standaloneSummaries }: AgentExtensionEditorProps) {
  const copy = useAgentExtensionCopy(), scopeKey = agentExtensionEditorContextKey(context, target);
  const [query, setQuery] = useState(''), [filters, setFilters] = useState<Filters>(initialFilters), [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchData | null>(null), [searchPending, setSearchPending] = useState(false), [searchError, setSearchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0), [detail, setDetail] = useState<AgentExtensionSearchItem | null>(null);
  const [selectedPin, setSelectedPin] = useState<ExtensionPackagePin | null>(null), [detailMetadata, setDetailMetadata] = useState<AgentExtensionPackageVersion | null>(null);
  const [detailPending, setDetailPending] = useState(false), [detailError, setDetailError] = useState<string | null>(null);
  const [cachedPackages, setCachedPackages] = useState<Record<string, AgentExtensionPackageVersion>>({});
  const [connectionPresentation, setConnectionPresentation] = useState<Record<string, AgentExtensionConnectionPresentation>>({});
  const [validation, setValidation] = useState<AgentExtensionEditorValidation>({ pending: true, blocked: true, preview: null, error: null });
  const [previewRefresh, setPreviewRefresh] = useState(0), [draftNotice, setDraftNotice] = useState(false);
  const [restorable, setRestorable] = useState<ReturnType<typeof readAgentExtensionDraft>>(null);
  const [persistDraft, setPersistDraft] = useState(false);
  const [resetIntent, setResetIntent] = useState<'inherit' | 'fixed' | null>(null), [resetConfirmed, setResetConfirmed] = useState(false);
  const onValidation = useRef(onValidationChange);
  const alive = useRef(true), searchEpoch = useRef(0), searchContext = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null), resultList = useRef<HTMLDivElement | null>(null);
  const resultButtons = useRef(new Map<string, HTMLButtonElement>()), resultScroll = useRef(0);
  const [initialValue] = useState(value);
  const previewKey = JSON.stringify([scopeKey, value, enabledTools, model]), currentPreviewKey = useRef(previewKey);
  useLayoutEffect(() => { onValidation.current = onValidationChange; currentPreviewKey.current = previewKey; }, [onValidationChange, previewKey]);
  const fixed = value.configuration?.mode === 'fixed' ? value.configuration : null;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!context.actorId) return;
    const saved = readAgentExtensionDraft(scopeKey);
    if (saved && JSON.stringify(saved.draft) !== JSON.stringify(initialValue)) queueMicrotask(() => { if (alive.current) setRestorable(saved); });
  }, [scopeKey, context.actorId, initialValue]);
  useEffect(() => {
    if (context.actorId && value.intent === 'replace' && value.configuration !== null
      && (persistDraft || JSON.stringify(value) !== JSON.stringify(initialValue))) saveAgentExtensionDraft(scopeKey, value);
  }, [scopeKey, context.actorId, value, initialValue, persistDraft]);
  const changeDraft = (next: AgentExtensionEditorDraft) => {
    if (disabled || !alive.current) return;
    setPersistDraft(true);
    onValidation.current?.({ pending: true, blocked: true, preview: null, error: null });
    onChange(next);
  };
  const mutate = (next: FixedAgentExtensionConfiguration) => changeDraft({ intent: 'replace', configuration: next });
  useEffect(() => {
    const controller = new AbortController(), version = ++searchEpoch.current;
    queueMicrotask(() => { if (!controller.signal.aborted) { setSearchPending(true); setSearchError(null); } });
    const timer = setTimeout(() => {
      void requestAgentExtensionOptions(context, { operation: 'search', target, q: query, ...filters, cursor, selected: null, limit: 20 }, controller.signal).then(result => {
        if (controller.signal.aborted || searchEpoch.current !== version) return;
        if (cursor && searchContext.current !== result.contextKey) throw new Error(copy('Der Suchkontext wurde geändert. Bitte erneut laden.', 'The search context changed. Reload the results.'));
        searchContext.current = result.contextKey;
        setSearch(previous => cursor && previous ? { ...result, items: [...previous.items, ...result.items.filter(row => !previous.items.some(old => old.item.id === row.item.id))] } : result);
      }).catch(reason => { if (!controller.signal.aborted && searchEpoch.current === version) setSearchError(reason instanceof Error ? reason.message : String(reason)); })
        .finally(() => { if (!controller.signal.aborted && searchEpoch.current === version) setSearchPending(false); });
    }, query ? 240 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
    // The keyed session binds the immutable actor/target context. Filter and cursor changes abort old results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters, cursor, refresh, scopeKey]);
  useEffect(() => {
    const controller = new AbortController(), captured = previewKey;
    const publish = (next: AgentExtensionEditorValidation) => {
      if (controller.signal.aborted || !alive.current || currentPreviewKey.current !== captured) return;
      setValidation(next); onValidation.current?.(next);
    };
    if (value.configuration === null) {
      publish({ pending: false, blocked: true, preview: null, error: copy('Die gespeicherte Auswahl ist nicht lesbar. Sie wird beim Bearbeiten nicht durch eine leere Auswahl ersetzt.', 'The saved selection is unavailable. Editing does not replace it with an empty selection.') });
      return () => controller.abort();
    }
    if (value.intent === 'replace') {
      const parsed = agentExtensionConfigurationInputSchema.safeParse(value.configuration);
      if (!parsed.success) {
        publish({ pending: false, blocked: true, preview: null, error: copy('Die Auswahl ist noch unvollständig. Prüfe Verbindungen, persönliche Regeln und Accountbestätigungen.', 'The selection is incomplete. Check connections, personal rules and account confirmations.') });
        return () => controller.abort();
      }
    }
    publish({ pending: true, blocked: true, preview: null, error: null });
    const timer = setTimeout(() => {
      void requestAgentExtensionOptions(context, { operation: 'preview', target,
        ...(value.intent === 'replace' ? { configuration: value.configuration! } : {}),
        ...(enabledTools === undefined ? {} : { enabledTools }), ...model }, controller.signal).then(result => {
        const preview = result.preview;
        publish({ pending: false, blocked: preview.configurationReadiness === 'blocked' || preview.configurationReadiness === 'incomplete'
          || preview.issues.some(issue => issue.severity === 'error'), preview, error: null });
      }).catch(reason => publish({ pending: false, blocked: true, preview: null, error: reason instanceof Error ? reason.message : String(reason) }));
    }, 280);
    return () => { clearTimeout(timer); controller.abort(); };
    // Callback identity must not reissue preview, and a result is delivered only for its captured exact draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewRefresh]);
  useEffect(() => {
    if (!selectedPin || !detail) return;
    const controller = new AbortController(), pin = selectedPin;
    queueMicrotask(() => { if (!controller.signal.aborted) { setDetailPending(true); setDetailError(null); setDetailMetadata(null); } });
    void requestAgentExtensionOptions(context, { operation: 'package_version', target, ...pin }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (extensionPinKey(result.package.pin) !== extensionPinKey(pin)) throw new Error(copy('Der veröffentlichte Stand wurde verändert.', 'The published version changed.'));
      setDetailMetadata(result.package); setCachedPackages(previous => ({ ...previous, [extensionPinKey(pin)]: result.package }));
    }).catch(reason => { if (!controller.signal.aborted) setDetailError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setDetailPending(false); });
    return () => controller.abort();
    // Exact source selection and scoped session determine package reads, never the mutable package head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPin, detail?.item.id, scopeKey]);
  const resetSearch = () => { setCursor(null); setSearch(null); searchContext.current = null; };
  const updateFilters = (next: Filters) => { resetSearch(); setFilters(next); };
  const openItem = (row: AgentExtensionSearchItem) => {
    resultScroll.current = resultList.current?.scrollTop ?? 0;
    setDetail(row); setDetailError(null); setDetailMetadata(null);
    const selected = row.selection;
    setSelectedPin(selected?.kind === 'plugin' || selected?.kind === 'skill' ? selected.package : row.publishedVersions?.[0]?.pin ?? null);
  };
  const closeDetail = () => {
    const id = detail?.item.id; setDetail(null); setSelectedPin(null); setDetailMetadata(null);
    window.requestAnimationFrame(() => {
      if (!alive.current) return;
      if (resultList.current) resultList.current.scrollTop = resultScroll.current;
      const button = id ? resultButtons.current.get(id) : undefined;
      (button ?? searchInput.current)?.focus({ preventScroll: true });
    });
  };
  const addPackage = () => {
    if (!fixed || !detailMetadata || !detail || disabled) return;
    try {
      let selection = detail.selection;
      if (selection?.kind === 'skill') {
        const root = selection.relativeRoot;
        if (!detailMetadata.children.some(child => child.relativeRoot === root)) throw new Error(copy('Dieser Skill ist in der gewählten Version nicht enthalten.', 'This skill is not part of the selected version.'));
        selection = { ...selection, package: detailMetadata.pin, origin: detailMetadata.kind === 'plugin' ? 'plugin_child' : 'standalone' };
      } else if (selection?.kind === 'plugin') selection = { ...selection, package: detailMetadata.pin };
      mutate(addExtensionPackage(fixed, detailMetadata, selection)); closeDetail();
    } catch (reason) { setDetailError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const addConnection = (choice: AgentExtensionChosenConnection) => {
    if (!fixed || disabled) return;
    const identity = extensionSelectionIdentity(choice.selection);
    if (fixed.standalone.some(slot => (slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices).some(entry => extensionSelectionIdentity(entry.selection) === identity))) {
      setDetailError(copy('Diese genaue Verbindung ist bereits ausgewählt.', 'This exact connection is already selected.')); return;
    }
    setConnectionPresentation(previous => ({ ...previous, [agentExtensionStandalonePresentationKey(choice.selection)]: { label: choice.label, ...(detail?.item.icon ? { icon: detail.item.icon } : {}) } }));
    mutate({ ...fixed, standalone: [...fixed.standalone, { mode: 'fixed', entry: { selection: choice.selection,
      requirement: 'optional', toolCap: null, ...(choice.accountSelectionRef ? { accountSelectionRef: choice.accountSelectionRef } : {}) } }] });
    closeDetail();
  };
  const addPersonalRule = () => {
    if (!fixed || !detail || disabled || detail.item.kind !== 'integration' && detail.item.kind !== 'mcp') return;
    const slot: AgentStandaloneConfigurationInput = detail.item.kind === 'integration' ? { mode: 'selectable', source: 'composio', toolkit: detail.item.toolkit.slug,
      configurationId: `slot-${crypto.randomUUID()}`, requirement: 'optional', allowedChoices: [], personalPolicy: { source: 'composio', toolkit: detail.item.toolkit.slug, toolCap: null } }
      : { mode: 'selectable', source: 'mcp', configurationId: `slot-${crypto.randomUUID()}`, requirement: 'optional', allowedChoices: [],
        ...(detail.item.mcp.definitionId ? { personalPolicy: { source: 'mcp' as const, serverDefinitionIds: [detail.item.mcp.definitionId], toolCap: null } } : {}) };
    mutate({ ...fixed, standalone: [...fixed.standalone, slot] }); closeDetail();
  };
  const setupUrl = (row: AgentExtensionSearchItem) => `/plugins?${new URLSearchParams({ view: 'browse',
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...((row.item.kind === 'plugin' || row.item.kind === 'skill') && row.item.package?.resourceRef
      ? { resourceRef: row.item.package.resourceRef, task: 'connections' } : { extensionId: row.item.id }) })}`;
  const kindLabel = (kind: string) => kind === 'integration' ? copy('Integration', 'Integration') : kind === 'mcp' ? copy('MCP-Server', 'MCP server') : kind === 'skill' ? 'Skill' : 'Plugin';
  const packageCount = fixed?.workflow?.packages.length ?? 0;
  return <section className="min-w-0 space-y-4" data-testid="agent-extension-editor" aria-label={copy('Erweiterungen und Werkzeuge', 'Extensions and tools')}>
    <div className="space-y-1"><h3 className="text-sm font-semibold">{copy('Erweiterungen und Werkzeuge', 'Extensions and tools')}</h3><p className="text-xs leading-relaxed text-muted-foreground">{copy('Dauerhaft für diesen Agenten. Plugins bündeln Skills und Verbindungen; jeder Bestandteil lässt sich auch einzeln auswählen.', 'Always available to this agent. Plugins bundle skills and connections; each component can also be selected separately.')}</p></div>
    {restorable ? <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs"><span className="flex-1">{copy('Ein gespeicherter Erweiterungsentwurf ist vorhanden.', 'A saved extension draft is available.')}</span>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { changeDraft(restorable.draft); setDraftNotice(restorable.requiresAccountReselection); setRestorable(null); }}>{copy('Entwurf fortsetzen', 'Resume draft')}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { clearAgentExtensionDraft(scopeKey); setRestorable(null); }}>{copy('Verwerfen', 'Discard')}</Button></div> : null}
    {draftNotice ? <p role="status" className="rounded-lg border p-3 text-xs">{copy('Persönliche Accountbestätigungen werden nicht gespeichert. Wähle die betroffenen Konten vor dem Speichern erneut.', 'Personal account confirmations are not stored. Choose the affected accounts again before saving.')}</p> : null}
    {value.configuration?.mode === 'legacy_inherit' ? <div className="space-y-3 rounded-xl border bg-muted/30 p-3"><h4 className="text-sm font-medium">{copy('Bestehende Vererbung', 'Existing inheritance')}</h4>
      <p className="text-xs text-muted-foreground">{copy('Der Agent erbt bisher verfügbare Erweiterungen. Diese Einstellung bleibt erhalten, bis du ausdrücklich eine feste Auswahl anlegst.', 'This agent inherits available extensions. This remains unchanged until you explicitly create a fixed selection.')}</p>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => mutate(emptyAgentExtensionConfiguration())}>{copy('Auf feste Auswahl umstellen', 'Switch to fixed selection')}</Button></div> : null}
    {fixed ? <>
      <div className="rounded-xl border bg-muted/20 p-3"><div className="flex items-center gap-2"><Search className="size-4 shrink-0 text-muted-foreground" />
        <Input ref={searchInput} aria-label={copy('Plugins, Skills, Integrationen und MCP suchen', 'Search plugins, skills, integrations and MCP')} placeholder={copy('Plugins, Skills, Integrationen und MCP suchen …', 'Search plugins, skills, integrations and MCP…')}
          maxLength={512} value={query} disabled={disabled} className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0" onChange={event => { resetSearch(); setQuery(event.target.value); setDetail(null); setSelectedPin(null); }} />
        {searchPending ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : null}</div>
        <details className="mt-2 border-t pt-2"><summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground"><SlidersHorizontal className="size-3.5" />{copy('Filter', 'Filters')}</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><select className={agentExtensionSelectClass} aria-label={copy('Erweiterungstyp', 'Extension type')} value={filters.types.length === 1 ? filters.types[0] : 'all'} disabled={disabled}
            onChange={event => updateFilters({ ...filters, types: event.target.value === 'all' ? initialFilters.types : [event.target.value as Filters['types'][number]] })}>
            <option value="all">{copy('Alle Typen', 'All types')}</option>{initialFilters.types.map(kind => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select>
            <select className={agentExtensionSelectClass} aria-label={copy('Bestand', 'Availability')} value={filters.stock} disabled={disabled} onChange={event => updateFilters({ ...filters, stock: event.target.value as Filters['stock'] })}>
              <option value="all">{copy('Verbunden und verfügbar', 'Connected and available')}</option><option value="installed">{copy('Bereits eingerichtet', 'Already set up')}</option><option value="available">{copy('Verfügbar zum Einrichten', 'Available to set up')}</option></select>
            <select className={agentExtensionSelectClass} aria-label={copy('Quelle', 'Source')} value={filters.source} disabled={disabled} onChange={event => updateFilters({ ...filters, source: event.target.value as Filters['source'] })}>
              <option value="all">{copy('Alle Quellen', 'All sources')}</option><option value="store">{copy('Paketkatalog', 'Package catalogue')}</option><option value="composio">Composio</option><option value="mcp">MCP</option></select>
            <select className={agentExtensionSelectClass} aria-label={copy('Berechtigungsbereich', 'Scope')} value={filters.scope} disabled={disabled} onChange={event => {
              const scope = event.target.value as Filters['scope']; updateFilters({ ...filters, scope, audience: null, teamId: scope === 'team' ? search?.scopes.teams[0]?.teamId ?? null : null });
            }}>{(search?.scopes.choices ?? ['all', 'user', 'organization', 'system']).filter(scope => scope !== 'team' || Boolean(search?.scopes.teams.length)).map(scope => <option key={scope} value={scope}>{scope === 'all' ? copy('Alle Bereiche', 'All scopes') : scope === 'user' ? copy('Persönlich', 'Personal') : scope === 'organization' ? copy('Organisation', 'Organization') : scope === 'system' ? 'System' : 'Team'}</option>)}</select>
            {filters.scope === 'team' ? <select className={agentExtensionSelectClass} aria-label="Team" value={filters.teamId ?? ''} disabled={disabled} onChange={event => updateFilters({ ...filters, teamId: event.target.value })}>{search?.scopes.teams.map(team => <option key={team.teamId} value={team.teamId}>{team.label}</option>)}</select> : null}
            {filters.scope === 'user' ? <select className={agentExtensionSelectClass} aria-label={copy('Besitz', 'Ownership')} value={filters.audience ?? 'all'} disabled={disabled} onChange={event => updateFilters({ ...filters, audience: event.target.value === 'all' ? null : event.target.value as 'own' | 'shared' })}><option value="all">{copy('Eigene und geteilte', 'Own and shared')}</option><option value="own">{copy('Eigene', 'Own')}</option><option value="shared">{copy('Mit mir geteilt', 'Shared with me')}</option></select> : null}
          </div></details>
      </div>
      {suggestedSkillNames?.length ? <p className="text-xs text-muted-foreground">{copy('Vorlagenhinweise: ', 'Template suggestions: ')}{suggestedSkillNames.map((name, index) => <span key={`${name}:${index}`}><button type="button" className="underline underline-offset-2" disabled={disabled} onClick={() => { resetSearch(); setQuery(name); setDetail(null); }}>{name}</button>{index + 1 < suggestedSkillNames.length ? ', ' : ''}</span>)}{' · '}{copy('erst suchen, dann ausdrücklich zuweisen', 'search first, then assign explicitly')}</p> : null}
      {detail ? <div className="space-y-3 rounded-xl border p-3" data-testid="agent-extension-result-detail"><Button type="button" variant="ghost" size="sm" onClick={closeDetail}><ChevronLeft className="size-3.5" />{copy('Zurück zu Treffern', 'Back to results')}</Button>
        <div className="flex items-center gap-3"><PluginExtensionAvatar name={detail.item.displayName} identity={`${scopeKey}:${detail.item.id}`} icon={detail.item.icon} /><div className="min-w-0"><h4 className="text-sm font-semibold">{detail.item.displayName}</h4><p className="text-xs text-muted-foreground">{kindLabel(detail.item.kind)}{detail.item.ownershipLabel ? ` · ${detail.item.ownershipLabel}` : ''}</p></div></div>
        <p className="text-xs leading-relaxed text-muted-foreground">{detail.item.description}</p>
        {detail.eligibility.reason ? <p className="text-xs text-muted-foreground">{detail.eligibility.reason.message}</p> : null}
        {(detail.item.kind === 'plugin' || detail.item.kind === 'skill') && selectedPin ? <>
          {detail.publishedVersions?.length ? <label className="block space-y-1 text-xs"><span>{copy('Veröffentlichte Version', 'Published version')}</span><select className={agentExtensionSelectClass} disabled={disabled || detailPending} value={selectedPin.publishedRevisionRef}
            onChange={event => { const pin = detail.publishedVersions?.find(row => row.pin.publishedRevisionRef === event.target.value)?.pin; if (pin) setSelectedPin(pin); }}>
            {detail.publishedVersions.map(row => <option key={row.pin.publishedRevisionRef} value={row.pin.publishedRevisionRef}>{row.version}</option>)}</select></label> : null}
          {detailPending ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-3.5 animate-spin" />{copy('Paketversion prüfen …', 'Checking package version…')}</p> : null}
          {detailMetadata ? <><p className="text-xs text-muted-foreground">{detailMetadata.version} · {detailMetadata.children.length} {copy('Skills', 'skills')}</p><Button type="button" size="sm" disabled={disabled || detail.eligibility.action === 'unavailable' || detail.eligibility.action === 'setup'} onClick={addPackage}><Plus className="size-3.5" />{copy('Für Agent auswählen', 'Select for agent')}</Button></> : null}
        </> : null}
        {detail.item.kind === 'integration' || detail.item.kind === 'mcp' ? <>
          <AgentExtensionConnectionChooser target={target} context={context} selector={detail.item.kind === 'integration' ? { kind: 'standalone', source: 'composio', toolkit: detail.item.toolkit.slug } : { kind: 'standalone', source: 'mcp' }} disabled={disabled} onSelect={addConnection} setupHref={setupUrl(detail)} />
          <Button type="button" size="sm" variant="outline" disabled={disabled || detail.eligibility.action === 'unavailable'} onClick={addPersonalRule}>{copy('Persönliche Wahlregel anlegen', 'Create a per-user choice rule')}</Button>
        </> : null}
        {detailError ? <p role="alert" className="text-xs text-destructive">{detailError}</p> : null}
        {detail.eligibility.action === 'setup' || detail.eligibility.action === 'unavailable' ? <a className="inline-flex items-center gap-1 text-xs underline underline-offset-2" href={setupUrl(detail)} target="_blank" rel="noopener noreferrer">{copy('Genauen Katalogeintrag öffnen', 'Open this catalogue entry')}<ExternalLink className="size-3" /></a> : null}
      </div> : <div ref={resultList} className="max-h-72 space-y-1 overflow-y-auto" data-testid="agent-extension-results">
        {search?.items.map(row => <button type="button" key={row.item.id} ref={node => { if (node) resultButtons.current.set(row.item.id, node); else resultButtons.current.delete(row.item.id); }} disabled={disabled} onClick={() => openItem(row)}
          aria-label={`${row.item.displayName} · ${kindLabel(row.item.kind)} · ${row.item.ownershipLabel || row.item.description} · ${row.eligibility.action === 'setup' ? copy('Einrichten', 'Set up') : row.eligibility.action === 'unavailable' ? copy('Nicht verfügbar', 'Unavailable') : copy('Verfügbar', 'Available')}`}
          className="flex w-full items-center gap-3 rounded-lg p-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <PluginExtensionAvatar size="sm" name={row.item.displayName} identity={`${scopeKey}:${row.item.id}`} icon={row.item.icon} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{row.item.displayName}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{kindLabel(row.item.kind)} · {row.item.ownershipLabel || row.item.description}</span></span>
          <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">{row.eligibility.action === 'setup' ? copy('Einrichten', 'Set up') : row.eligibility.action === 'unavailable' ? copy('Nicht verfügbar', 'Unavailable') : row.item.stock === 'installed' ? copy('Eingerichtet', 'Set up') : copy('Verfügbar', 'Available')}</span><ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        </button>)}
        {!searchPending && search && !search.items.length ? <p className="py-4 text-center text-sm text-muted-foreground">{copy('Keine passenden Erweiterungen.', 'No matching extensions.')}</p> : null}
        {search?.pagination.hasNextPage ? <Button type="button" size="sm" variant="ghost" disabled={disabled || searchPending || !search.pagination.nextCursor} onClick={() => setCursor(search.pagination.nextCursor)}>{copy('Weitere Treffer', 'More results')}</Button> : null}
      </div>}
      {searchError ? <div role="alert" className="text-xs text-destructive">{searchError}</div> : null}
      {search?.coverage.filter(source => source.status !== 'complete').map(source => <p key={source.source} className="text-xs text-muted-foreground">{source.source}: {source.error?.message ?? copy('Quelle derzeit nicht vollständig verfügbar.', 'Source currently incomplete.')}</p>)}
      <Button type="button" size="sm" variant="ghost" disabled={disabled || searchPending} onClick={() => { resetSearch(); setRefresh(count => count + 1); }}>{copy('Katalog aktualisieren', 'Refresh catalogue')}</Button>
      <div className="space-y-3 rounded-xl bg-muted/20 p-3"><div className="flex items-center gap-2"><Check className="size-3.5 text-muted-foreground" /><h4 className="text-xs font-semibold">{copy('Dauerhaft für diesen Agenten', 'Always available to this agent')}</h4><span className="ml-auto text-xs text-muted-foreground">{packageCount + fixed.standalone.length}</span></div>
        {packageCount + fixed.standalone.length === 0 ? <p className="py-2 text-xs leading-relaxed text-muted-foreground">{copy('Noch keine zusätzlichen Erweiterungen. Verpflichtende Basis-Skills bleiben durch die geltenden Regeln erhalten.', 'No additional extensions yet. Required base skills remain governed by the current policies.')}</p> : null}
        {fixed.workflow?.packages.map(pkg => <AgentExtensionPackageEditor key={extensionPinKey(pkg)} configuration={fixed} pkg={pkg} target={target} context={context}
          initialMetadata={cachedPackages[extensionPinKey(pkg)]} disabled={disabled} onChange={mutate} bindingSummaries={bindingSummaries} />)}
        {fixed.standalone.map((slot, index) => <AgentExtensionStandaloneEditor key={slot.configurationId ?? `new-${index}`} slot={slot} target={target} context={context} disabled={disabled} presentation={connectionPresentation} summaries={standaloneSummaries}
          onChange={next => mutate({ ...fixed, standalone: fixed.standalone.map((row, rowIndex) => rowIndex === index ? next : row) })}
          onRemove={() => mutate({ ...fixed, standalone: fixed.standalone.filter((_, rowIndex) => rowIndex !== index) })} />)}
      </div>
    </> : null}
    <div className="space-y-2 rounded-xl border p-3" aria-live="polite" data-testid="agent-extension-preview-status">
      <p className="flex items-center gap-2 text-xs font-medium">{validation.pending ? <Loader2 className="size-3.5 animate-spin" /> : null}{validation.pending ? copy('Konfiguration wird geprüft …', 'Checking configuration…')
        : validation.blocked ? copy('Vor dem Speichern prüfen', 'Review before saving') : validation.preview?.configurationReadiness === 'unknown' ? copy('Vererbung bleibt erhalten', 'Inheritance is preserved') : copy('Konfiguration geprüft', 'Configuration checked')}</p>
      {validation.error ? <p role="alert" className="text-xs text-destructive">{validation.error}</p> : null}
      {validation.preview?.issues.map((issue, index) => <p key={`${issue.code}:${index}`} className={`text-xs ${issue.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{issue.message}</p>)}
      {validation.preview?.personalSetupRequired ? <p className="text-xs text-muted-foreground">{copy('Die Wahlregel kann gespeichert werden. Jeder Nutzer richtet seine erforderliche Verbindung unter „Meine Verbindung“ ein.', 'The choice rule can be saved. Each user sets up their required connection under “My connection”.')}</p> : null}
      <p className="text-xs text-muted-foreground">{copy('Die Vorschau prüft den Konfigurationskontext. Provider-Erreichbarkeit ist ungeprüft; Speichern prüft Rechte und Quellen erneut.', 'The preview checks configuration context. Provider reachability is unchecked; saving revalidates permissions and sources.')}</p>
      <details className="pt-1"><summary className="cursor-pointer text-xs font-medium">{copy('Werkzeuge und Kontextvorschau', 'Tools and context preview')}</summary><div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">{copy('Native Werkzeugauswahl: ', 'Native tool selection: ')}{enabledTools === undefined ? copy('bestehenden Stand behalten', 'keep current configuration') : enabledTools === null ? copy('Provider-Vererbung', 'inherit provider tools') : enabledTools.length === 0 ? copy('Registry-Vorgaben', 'registry defaults') : enabledTools.includes('__none__') ? copy('keine Werkzeuge', 'no tools') : enabledTools.join(', ')}</p>
        {validation.preview?.effectiveToolCaps.map((row, index) => <p key={index} className="break-words text-xs text-muted-foreground">{kindLabel(row.selection.kind === 'composio' ? 'integration' : row.selection.kind)}: {row.toolCap === null ? copy('vorhandene Grenzen erben', 'inherit existing limits') : row.toolCap.length ? row.toolCap.join(', ') : copy('keine Werkzeuge', 'no tools')}</p>)}
        {validation.preview ? <p className="text-xs text-muted-foreground">{validation.preview.budget.usedBytes} / {validation.preview.budget.maxBytes} Bytes · {validation.preview.contextValidation === 'complete' ? copy('vollständig berechnet', 'fully calculated') : copy('Umfang unbekannt', 'scope unknown')}</p> : null}
        {validation.preview?.contextPreview ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">{validation.preview.contextPreview}</pre> : null}
      </div></details>
      <Button type="button" size="sm" variant="ghost" disabled={disabled || validation.pending || value.configuration === null} onClick={() => setPreviewRefresh(count => count + 1)}>{copy('Vorschau aktualisieren', 'Refresh preview')}</Button>
    </div>
    {target.kind === 'existing' ? <details className="rounded-xl border p-3" data-testid="agent-extension-advanced-reset"><summary className="cursor-pointer text-xs font-medium">{copy('Erweiterte Konfigurationsänderung', 'Advanced configuration changes')}</summary>
      <div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">{copy('Eine bewusste Umstellung ersetzt die vollständige Erweiterungsauswahl. Profil, Dateien und Modell bleiben in deinem Formular erhalten.', 'An explicit reset replaces the complete extension selection. Profile, files and model remain in your form.')}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={disabled || value.configuration?.mode === 'legacy_inherit'} data-testid="agent-extension-reset-inherit"
          onClick={() => { setResetIntent('inherit'); setResetConfirmed(false); }}>{copy('Bestehende Vererbung verwenden', 'Use legacy inheritance')}</Button>
          <Button type="button" size="sm" variant="outline" disabled={disabled} data-testid="agent-extension-reset-fixed"
            onClick={() => { setResetIntent('fixed'); setResetConfirmed(false); }}>{copy('Feste Auswahl neu aufbauen', 'Rebuild fixed selection')}</Button></div>
        {resetIntent ? <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="agent-extension-reset-confirmation">
          <p className="text-xs">{resetIntent === 'inherit' ? copy('Der Agent soll verfügbare Erweiterungen wieder nach den bisherigen Vererbungsregeln erhalten. Seine feste Auswahl wird vollständig ersetzt.', 'The agent will receive available extensions under legacy inheritance rules. Its fixed selection will be completely replaced.')
            : copy('Beginne mit einer ausdrücklich leeren festen Auswahl und füge die gewünschten Erweiterungen neu hinzu. Die bisherige Auswahl wird vollständig ersetzt.', 'Start with an explicitly empty fixed selection and add the desired extensions again. The current selection will be completely replaced.')}</p>
          <label className="flex items-start gap-2 text-xs"><WorkflowCheckbox data-testid="agent-extension-reset-confirm" disabled={disabled} checked={resetConfirmed} onCheckedChange={setResetConfirmed} />{copy('Ich bestätige, dass die bisherige Erweiterungsauswahl ersetzt wird.', 'I confirm that the current extension selection will be replaced.')}</label>
          <div className="flex gap-2"><Button type="button" size="sm" disabled={disabled || !resetConfirmed} data-testid="agent-extension-reset-apply" onClick={() => {
            changeDraft({ intent: 'replace', configuration: resetIntent === 'inherit' ? { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' } : emptyAgentExtensionConfiguration() });
            setResetIntent(null); setResetConfirmed(false);
          }}>{copy('Umstellung bestätigen', 'Confirm reset')}</Button><Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setResetIntent(null); setResetConfirmed(false); }}>{copy('Abbrechen', 'Cancel')}</Button></div>
        </div> : null}
      </div></details> : null}
  </section>;
}
