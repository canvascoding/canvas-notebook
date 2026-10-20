'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginExtensionAvatar } from '@/app/components/plugins/PluginExtensionAvatar';
import { extensionSelectionIdentity, type AgentStandaloneConfigurationInput, type StandaloneExtensionSelection } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionConfigurationTarget } from '@/app/lib/agents/extension-options-contracts';
import { agentExtensionStandalonePresentationKey, type AgentExtensionStandaloneSummary } from '@/app/lib/agents/extension-presentation-contracts';
import type { PluginExtensionIcon } from '@/app/lib/plugins/plugin-extension-icons';
import type { AgentExtensionEditorContext } from './AgentExtensionEditor';
import { AgentExtensionConnectionChooser, type AgentExtensionChosenConnection } from './AgentExtensionConnectionChooser';
import { AgentExtensionPersonalDefinitions } from './AgentExtensionPersonalDefinitions';
import { AgentExtensionToolCapEditor, agentExtensionSelectClass } from './AgentExtensionToolCapEditor';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';
import { WorkflowCheckbox } from './WorkflowCheckbox';

export type AgentExtensionConnectionPresentation = { label: string; icon?: PluginExtensionIcon };
export function AgentExtensionStandaloneEditor({ slot, target, context, disabled, onChange, onRemove, presentation, summaries }: {
  slot: AgentStandaloneConfigurationInput; target: AgentExtensionConfigurationTarget; context: AgentExtensionEditorContext;
  disabled?: boolean; onChange: (slot: AgentStandaloneConfigurationInput) => void; onRemove: () => void;
  presentation?: Record<string, AgentExtensionConnectionPresentation>; summaries?: readonly AgentExtensionStandaloneSummary[];
}) {
  const copy = useAgentExtensionCopy(), [chooser, setChooser] = useState(false), [labels, setLabels] = useState<Record<string, string>>({});
  const [definitionDraft, setDefinitionDraft] = useState<string[]>([]);
  const [replaceChoiceId, setReplaceChoiceId] = useState<string | null>(null);
  const [reconfirm, setReconfirm] = useState(false);
  const [forceFixed, setForceFixed] = useState(false);
  const source = slot.mode === 'fixed' ? slot.entry.selection.source : slot.source;
  const toolkit = slot.mode === 'fixed' ? slot.entry.selection.kind === 'composio' ? slot.entry.selection.toolkit : undefined : slot.source === 'composio' ? slot.toolkit : undefined;
  const selector = source === 'composio' && toolkit ? { kind: 'standalone' as const, source: 'composio' as const, toolkit } : { kind: 'standalone' as const, source: 'mcp' as const };
  const storedPresentation = (selection: StandaloneExtensionSelection, choiceId?: string) => summaries?.find(row =>
    row.configurationId === slot.configurationId && row.choiceId === choiceId
    && agentExtensionStandalonePresentationKey(row.selection) === agentExtensionStandalonePresentationKey(selection));
  const firstSelection = slot.mode === 'fixed' ? slot.entry.selection : slot.allowedChoices[0]?.selection;
  const firstStored = firstSelection ? storedPresentation(firstSelection, slot.mode === 'selectable' ? slot.allowedChoices[0]?.choiceId : undefined) : undefined;
  const firstPresentation = firstSelection ? presentation?.[agentExtensionStandalonePresentationKey(firstSelection)] ?? firstStored : undefined;
  const title = firstPresentation?.label ?? (source === 'composio' ? toolkit! : copy('MCP-Server', 'MCP server'));
  const connectionLabel = (selection: StandaloneExtensionSelection, choiceId?: string) => labels[agentExtensionStandalonePresentationKey(selection)]
    ?? presentation?.[agentExtensionStandalonePresentationKey(selection)]?.label
    ?? storedPresentation(selection, choiceId)?.label
    ?? (selection.target.kind === 'personal' ? copy('Gespeicherte persönliche Verbindung', 'Saved personal connection') : copy('Gespeicherte geteilte Verbindung', 'Saved shared connection'));
  const connectionContext = (selection: StandaloneExtensionSelection, choiceId?: string) => {
    const metadata = storedPresentation(selection, choiceId);
    if (!metadata) return null;
    const scope = metadata.scopeLabel === 'personal' ? selection.kind === 'composio'
      ? selection.target.kind === 'personal' && selection.target.accountBinding === 'no_auth'
        ? copy('Persönliche Integration ohne Anmeldung', 'Personal integration without sign-in')
        : copy('Gespeichertes persönliches Konto', 'Saved personal account')
      : copy('Persönliche Verbindung', 'Personal connection')
      : metadata.scopeLabel === 'team' ? copy('Teamverbindung', 'Team connection')
        : metadata.scopeLabel === 'system' ? copy('Systemverbindung', 'System connection') : copy('Organisationsverbindung', 'Organization connection');
    return <span className="block text-xs text-muted-foreground">{scope}{metadata.profileLabel
      ? <span className="block">{copy('Profil', 'Profile')}: {metadata.profileLabel}</span> : null}</span>;
  };
  const exactIdentity = (selection: StandaloneExtensionSelection) => <details className="rounded-md border p-2.5"><summary className="cursor-pointer text-xs font-medium">{copy('Genaue Verbindungsidentität', 'Exact connection identity')}</summary>
    <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{JSON.stringify(selection, null, 2)}</pre></details>;
  const choose = (choice: AgentExtensionChosenConnection) => {
    const identity = extensionSelectionIdentity(choice.selection);
    setLabels(previous => ({ ...previous, [agentExtensionStandalonePresentationKey(choice.selection)]: choice.label }));
    const entry = { selection: choice.selection, toolCap: null, ...(choice.accountSelectionRef ? { accountSelectionRef: choice.accountSelectionRef } : {}) };
    if (slot.mode === 'fixed' || forceFixed) {
      const previous = slot.mode === 'selectable' ? slot.allowedChoices.find(row => extensionSelectionIdentity(row.selection) === identity) : undefined;
      onChange({ mode: 'fixed', ...(slot.configurationId ? { configurationId: slot.configurationId } : {}), entry: { ...entry,
        toolCap: slot.mode === 'fixed' ? slot.entry.toolCap : previous ? previous.toolCap : null,
        requirement: slot.mode === 'fixed' ? slot.entry.requirement : slot.requirement } });
    }
    else {
      const existing = slot.allowedChoices.find(row => extensionSelectionIdentity(row.selection) === identity);
      const choiceId = replaceChoiceId ?? existing?.choiceId ?? choice.choiceId ?? `choice-${crypto.randomUUID()}`;
      if (existing && existing.choiceId !== choiceId) return;
      onChange({ ...slot, allowedChoices: [...slot.allowedChoices.filter(row => row.choiceId !== choiceId), { ...entry, choiceId,
        toolCap: slot.allowedChoices.find(row => row.choiceId === choiceId)?.toolCap ?? null }] });
    }
    setChooser(false); setReplaceChoiceId(null); setReconfirm(false); setForceFixed(false);
  };
  const changeMode = (mode: string) => {
    if (mode === slot.mode) return;
    setForceFixed(false);
    if (slot.mode === 'fixed') {
      const { requirement, ...entry } = slot.entry;
      const movedEntry = { selection: entry.selection, toolCap: entry.toolCap,
        ...(entry.accountSelectionRef ? { accountSelectionRef: entry.accountSelectionRef } : {}) };
      // A retained seal belongs to its original fixed/choice slot. A changed mode
      // rechecks the actual selection and requires a new account receipt if needed.
      setReconfirm(Boolean(entry.retainedBindingRef && entry.selection.kind === 'composio' && entry.selection.target.kind === 'personal'
        && entry.selection.target.accountBinding === 'account'));
      const base = { mode: 'selectable' as const, configurationId: slot.configurationId ?? `slot-${crypto.randomUUID()}`, requirement,
        allowedChoices: [{ ...movedEntry, choiceId: `choice-${crypto.randomUUID()}` }] };
      onChange(source === 'composio' ? { ...base, source: 'composio', toolkit: toolkit! } : { ...base, source: 'mcp' });
    } else {
      const selected = slot.allowedChoices.find(choice => choice.choiceId === slot.defaultChoiceId)
        ?? (slot.allowedChoices.length === 1 ? slot.allowedChoices[0] : undefined);
      if (!selected) { setForceFixed(true); setChooser(true); setReconfirm(true); return; }
      if (selected) onChange({ mode: 'fixed', configurationId: slot.configurationId, entry: { selection: selected.selection,
        toolCap: selected.toolCap, requirement: slot.requirement, ...(selected.accountSelectionRef ? { accountSelectionRef: selected.accountSelectionRef } : {}),
      } });
      setReconfirm(Boolean(selected?.retainedBindingRef && selected.selection.kind === 'composio' && selected.selection.target.kind === 'personal'
        && selected.selection.target.accountBinding === 'account'));
    }
  };
  return <details className="rounded-xl border bg-background" data-testid="agent-extension-standalone">
    <summary className="flex cursor-pointer list-none items-center gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><PluginExtensionAvatar size="sm" name={title} identity={firstSelection ? extensionSelectionIdentity(firstSelection) : JSON.stringify(selector)} icon={firstPresentation?.icon} />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{slot.mode === 'fixed' ? connectionLabel(slot.entry.selection) : copy('Pro Person auswählbar', 'Selected by each user')}</span>{slot.mode === 'fixed' ? connectionContext(slot.entry.selection) : null}</span>
      <span className="text-xs text-muted-foreground">{copy('Anpassen', 'Customize')}</span></summary>
    <div className="space-y-3 border-t p-3">
    <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><select className={agentExtensionSelectClass} disabled={disabled} aria-label={copy('Verbindungsmodus', 'Connection mode')} value={slot.mode} onChange={event => changeMode(event.target.value)}>
      <option value="fixed" disabled={slot.mode === 'selectable' && !slot.allowedChoices.length}>{copy('Feste Verbindung', 'Fixed connection')}</option><option value="selectable">{copy('Pro Person auswählbar', 'Selected by each user')}</option></select>
      <label className="flex items-center gap-2 text-xs"><WorkflowCheckbox disabled={disabled} checked={(slot.mode === 'fixed' ? slot.entry.requirement : slot.requirement) === 'required'}
        onCheckedChange={checked => onChange(slot.mode === 'fixed' ? { ...slot, entry: { ...slot.entry, requirement: checked ? 'required' : 'optional' } } : { ...slot, requirement: checked ? 'required' : 'optional' })} />{copy('Erforderlich', 'Required')}</label></div>
    {reconfirm ? <p role="status" className="text-xs text-muted-foreground">{copy('Bestätige die konkrete Verbindung ausdrücklich, bevor du den neuen Modus speicherst.', 'Explicitly confirm the connection before saving the new mode.')}</p> : null}
    {slot.mode === 'fixed' ? <div className="space-y-2"><div className="text-sm">{connectionLabel(slot.entry.selection)}{connectionContext(slot.entry.selection)}</div>
      {exactIdentity(slot.entry.selection)}
      <AgentExtensionToolCapEditor value={slot.entry.toolCap} disabled={disabled} onChange={toolCap => onChange({ ...slot, entry: { ...slot.entry, toolCap } })} />
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setReplaceChoiceId(null); setChooser(!chooser); }}>{copy('Verbindung ändern', 'Change connection')}</Button></div> : <>
      <p className="text-xs text-muted-foreground">{copy('Nutzende können eine erlaubte Verbindung oder nach der folgenden Regel ihre eigene Verbindung wählen.', 'Users may select an allowed connection or use their own connection under the rule below.')}</p>
      {slot.allowedChoices.map((choice, index) => <div key={choice.choiceId} className="space-y-2 rounded-lg border p-2.5">
        <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{connectionLabel(choice.selection, choice.choiceId)}{connectionContext(choice.selection, choice.choiceId)}</span>
          <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={copy('Erlaubte Verbindung entfernen', 'Remove allowed connection')} onClick={() => onChange({ ...slot,
            allowedChoices: slot.allowedChoices.filter(row => row.choiceId !== choice.choiceId), defaultChoiceId: slot.defaultChoiceId === choice.choiceId ? undefined : slot.defaultChoiceId })}><Trash2 className="size-3.5" /></Button></div>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setReplaceChoiceId(choice.choiceId); setChooser(true); }}>{copy('Verbindung ändern', 'Change connection')}</Button>
        {exactIdentity(choice.selection)}
        <AgentExtensionToolCapEditor value={choice.toolCap} disabled={disabled} onChange={toolCap => onChange({ ...slot, allowedChoices: slot.allowedChoices.map((row, rowIndex) => rowIndex === index ? { ...row, toolCap } : row) })} />
      </div>)}
      <Button type="button" size="sm" variant="outline" disabled={disabled || slot.allowedChoices.length >= 32} onClick={() => { setReplaceChoiceId(null); setChooser(!chooser); }}><Plus className="size-3.5" />{copy('Erlaubte Verbindung hinzufügen', 'Add allowed connection')}</Button>
      <label className="block space-y-1 text-xs"><span>{copy('Vorgabe', 'Default')}</span><select className={agentExtensionSelectClass} disabled={disabled} value={slot.defaultChoiceId ?? ''}
        onChange={event => onChange({ ...slot, defaultChoiceId: event.target.value || undefined })}><option value="">{copy('Keine Vorgabe · persönliche Wahl nötig', 'No default · user choice required')}</option>
        {slot.allowedChoices.map((choice, index) => <option key={choice.choiceId} value={choice.choiceId}>{connectionLabel(choice.selection, choice.choiceId)} · {index + 1}</option>)}</select></label>
      <details className="rounded-lg border bg-muted/20 p-3"><summary className="cursor-pointer text-xs font-medium">{copy('Eigene Verbindungen erlauben', 'Allow personal connections')}</summary>
        <div className="mt-3 space-y-3">{source === 'composio' ? <label className="flex items-start gap-2 text-xs"><WorkflowCheckbox checked={Boolean(slot.personalPolicy)} disabled={disabled}
          onCheckedChange={checked => onChange({ ...slot, personalPolicy: checked ? { source: 'composio', toolkit: toolkit!, toolCap: null } : undefined })} />{copy('Eigenes Konto für diese Integration zulassen', 'Allow each user’s account for this integration')}</label> : <>
          <AgentExtensionPersonalDefinitions context={context} disabled={disabled} value={slot.personalPolicy?.source === 'mcp' ? slot.personalPolicy.serverDefinitionIds : definitionDraft}
            onChange={ids => { setDefinitionDraft(ids); onChange({ ...slot, personalPolicy: ids.length ? { source: 'mcp', serverDefinitionIds: ids, toolCap: slot.personalPolicy?.toolCap ?? null } : undefined }); }} />
        </>}
          {slot.personalPolicy ? <AgentExtensionToolCapEditor value={slot.personalPolicy.toolCap} disabled={disabled} onChange={toolCap => onChange({ ...slot, personalPolicy: { ...slot.personalPolicy!, toolCap } })} /> : null}
        </div></details>
    </>}
    {chooser ? <div className="space-y-2"><AgentExtensionConnectionChooser target={target} context={context} selector={selector} disabled={disabled} onSelect={choose} />
      <Button type="button" size="sm" variant="ghost" onClick={() => { setChooser(false); setReplaceChoiceId(null); setForceFixed(false); setReconfirm(false); }}>{copy('Abbrechen', 'Cancel')}</Button></div> : null}
    <Button type="button" size="sm" variant="ghost" disabled={disabled} className="text-muted-foreground" onClick={onRemove}><Trash2 className="size-3.5" />{copy('Erweiterung entfernen', 'Remove extension')}</Button>
    </div>
  </details>;
}
