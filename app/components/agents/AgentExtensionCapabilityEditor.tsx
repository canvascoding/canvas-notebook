'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import type { WorkflowIntegrationCapability } from '@/app/lib/capabilities/workflow-contracts';
import type { AgentWorkflowPackageConfiguration, AgentWorkflowSelection } from '@/app/lib/agents/workflow-public-contracts';
import type { AgentExtensionConfigurationTarget } from '@/app/lib/agents/extension-options-contracts';
import type { AgentWorkflowManagementBindingSummary } from '@/app/lib/agents/workflow-management-contracts';
import type { AgentExtensionEditorContext } from './AgentExtensionEditor';
import { AgentExtensionConnectionChooser, type AgentExtensionChosenConnection } from './AgentExtensionConnectionChooser';
import { AgentExtensionPersonalDefinitions } from './AgentExtensionPersonalDefinitions';
import { AgentExtensionToolCapEditor, agentExtensionSelectClass } from './AgentExtensionToolCapEditor';
import { extensionAlternativeKey } from './agent-extension-editor-draft';
import { useAgentExtensionCopy } from './agent-extension-editor-copy';
import { WorkflowCheckbox } from './WorkflowCheckbox';

type Capability = AgentWorkflowPackageConfiguration['declarations'][number]['capabilities'][number];
type Props = { definition: WorkflowIntegrationCapability; pin: ExtensionPackagePin; declarationPath: string;
  value: Capability | undefined; target: AgentExtensionConfigurationTarget; context: AgentExtensionEditorContext;
  bindingSummaries?: readonly AgentWorkflowManagementBindingSummary[];
  disabled?: boolean; onChange: (capability: Capability | null) => void };

export function AgentExtensionCapabilityEditor({ definition, pin, declarationPath, value, target, context, disabled, onChange, bindingSummaries }: Props) {
  const copy = useAgentExtensionCopy(), [open, setOpen] = useState(false), [chooser, setChooser] = useState(false);
  const [alternative, setAlternative] = useState(definition.alternatives[0] ? extensionAlternativeKey(definition.alternatives[0]) : '');
  const [replaceChoiceId, setReplaceChoiceId] = useState<string | null>(null), [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null), [definitionDrafts, setDefinitionDrafts] = useState<Record<string, string[]>>({});
  const [forceFixed, setForceFixed] = useState(false), [movedToolCap, setMovedToolCap] = useState<string[] | null>(null);
  const selection = value?.selection, required = definition.required || value?.required === true;
  const update = (next: AgentWorkflowSelection) => { setError(null); onChange({ capabilityId: definition.id, required, selection: next }); };
  const label = (item: { choiceId?: string; alternativeKey: string; target: import('@/app/lib/agents/workflow-public-contracts').AgentWorkflowTarget }) => {
    const saved = item.target.kind === 'retained' ? bindingSummaries?.find(summary => summary.alternativeKey === item.alternativeKey && summary.choiceId === item.choiceId) : undefined;
    return labels[item.choiceId ?? 'fixed'] ?? (saved ? `${saved.label} · ${saved.scopeLabel === 'personal' ? copy('Persönlich', 'Personal') : saved.scopeLabel === 'team' ? 'Team' : copy('Organisation', 'Organization')}`
      : `${item.alternativeKey} · ${item.target.kind === 'retained' ? copy('Gespeicherte Verbindung', 'Saved connection') : item.target.kind === 'shared' ? copy('Geteilt', 'Shared') : copy('Persönlich', 'Personal')}`);
  };
  const choose = (choice: AgentExtensionChosenConnection) => {
    if (!choice.packageBinding) { setError(copy('Für diese Paketanforderung fehlt die geprüfte Zuordnung. Bitte erneut auswählen.', 'This package requirement needs a checked binding. Please choose again.')); return; }
    const binding = choice.packageBinding;
    if (binding.alternativeKey !== alternative) { setError(copy('Die Alternative wurde geändert. Bitte erneut auswählen.', 'The alternative changed. Please choose again.')); return; }
    setError(null);
    if (selection?.mode === 'selectable' && !forceFixed) {
      const choiceId = replaceChoiceId ?? choice.choiceId ?? `choice-${crypto.randomUUID()}`;
      const previous = selection.allowedChoices.find(row => row.choiceId === choiceId);
      const next = { choiceId, alternativeKey: binding.alternativeKey, target: binding.target,
        toolCap: previous ? previous.toolCap : movedToolCap };
      update({ ...selection, allowedChoices: [...selection.allowedChoices.filter(row => row.choiceId !== choiceId), next] });
      setLabels(previous => ({ ...previous, [choiceId]: choice.label }));
    } else {
      update({ mode: 'fixed', ...binding, toolCap: selection?.mode === 'fixed' ? selection.toolCap : movedToolCap });
      setLabels(previous => ({ ...previous, fixed: choice.label }));
    }
    setChooser(false); setReplaceChoiceId(null); setForceFixed(false);
  };
  const setMode = (mode: string) => {
    setForceFixed(false);
    if (mode === 'none') { onChange(null); setChooser(false); return; }
    if (mode === 'selectable') {
      if (selection?.mode === 'fixed') setMovedToolCap(selection.toolCap);
      const retained = selection?.mode === 'fixed' && selection.target.kind === 'retained';
      update({ mode: 'selectable', allowedChoices: selection?.mode === 'fixed' && !retained ? [{ choiceId: `choice-${crypto.randomUUID()}`,
        alternativeKey: selection.alternativeKey, target: selection.target, toolCap: selection.toolCap }] : [] });
      if (retained) setError(copy('Der neue Modus benötigt eine erneut gewählte Verbindung oder eine vollständige persönliche Wahlregel.', 'The new mode needs a freshly chosen connection or a complete personal choice rule.'));
      setChooser(false);
    } else if (selection?.mode === 'selectable' && selection.allowedChoices.length) {
      const chosen = selection.allowedChoices.find(row => row.choiceId === selection.defaultChoiceId)
        ?? (selection.allowedChoices.length === 1 ? selection.allowedChoices[0] : undefined);
      if (!chosen || chosen.target.kind === 'retained') {
        if (chosen) { setAlternative(chosen.alternativeKey); setMovedToolCap(chosen.toolCap); }
        setForceFixed(true); setChooser(true);
        setError(copy('Bestätige die Verbindung erneut, um sie fest zuzuordnen. Bis dahin bleibt der bisherige Modus erhalten.', 'Confirm the connection again to assign it as fixed. Until then, the current mode is preserved.'));
      } else update({ mode: 'fixed', alternativeKey: chosen.alternativeKey, target: chosen.target, toolCap: chosen.toolCap });
    } else { setChooser(true); setOpen(true); }
  };
  return <section className="rounded-lg border bg-muted/20 p-3" data-testid="agent-extension-capability">
    <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}
      aria-label={`${definition.application} · ${required ? copy('Erforderliche Verbindung', 'Required connection') : copy('Optionale Verbindung', 'Optional connection')}`}>
      <span className="min-w-0"><span className="block text-sm font-medium capitalize">{definition.application}</span><span className="mt-0.5 block text-xs text-muted-foreground">{required ? copy('Erforderliche Verbindung', 'Required connection') : copy('Optionale Verbindung', 'Optional connection')}
        {' · '}{selection?.mode === 'fixed' ? label(selection) : selection?.mode === 'selectable' ? copy('Persönliche Wahl', 'Per-user choice') : copy('Noch nicht zugeordnet', 'Not assigned')}</span></span>
      <span className="shrink-0 text-xs text-muted-foreground">{open ? copy('Schließen', 'Close') : copy('Zuordnen', 'Assign')}</span>
    </button>
    {open ? <div className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{definition.id}</p><label className="flex items-center gap-2 text-xs"><WorkflowCheckbox checked={required}
        disabled={disabled || definition.required || !value} onCheckedChange={checked => { if (value) onChange({ ...value, required: checked }); }} />{copy('Erforderlich', 'Required')}</label></div>
      <select className={agentExtensionSelectClass} value={selection?.mode ?? 'none'} disabled={disabled} aria-label={copy('Zuordnung für ', 'Binding for ') + definition.application} onChange={event => setMode(event.target.value)}>
        <option value="none">{copy('Noch nicht zugeordnet', 'Not assigned')}</option><option value="fixed">{copy('Feste Verbindung', 'Fixed connection')}</option><option value="selectable">{copy('Pro Person auswählbar', 'Selected by each user')}</option>
      </select>
      {selection?.mode === 'fixed' ? <><p className="text-sm">{label(selection)}</p><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setAlternative(selection.alternativeKey); setReplaceChoiceId(null); setChooser(!chooser); }}>{copy('Verbindung ändern', 'Change connection')}</Button>
        <AgentExtensionToolCapEditor value={selection.toolCap} disabled={disabled} onChange={toolCap => update({ ...selection, toolCap })} /></> : null}
      {selection?.mode === 'selectable' ? <>
        {selection.allowedChoices.map(choice => <div className="space-y-2 rounded-lg border bg-background p-2.5" key={choice.choiceId}>
          <div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-xs">{label(choice)}</p><Button type="button" size="icon" variant="ghost" disabled={disabled} aria-label={copy('Erlaubte Verbindung entfernen', 'Remove allowed connection')}
            onClick={() => update({ ...selection, allowedChoices: selection.allowedChoices.filter(row => row.choiceId !== choice.choiceId), defaultChoiceId: selection.defaultChoiceId === choice.choiceId ? undefined : selection.defaultChoiceId })}><Trash2 className="size-3.5" /></Button></div>
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setAlternative(choice.alternativeKey); setReplaceChoiceId(choice.choiceId); setChooser(true); }}>{copy('Verbindung ändern', 'Change connection')}</Button>
          <AgentExtensionToolCapEditor value={choice.toolCap} disabled={disabled} onChange={toolCap => update({ ...selection, allowedChoices: selection.allowedChoices.map(row => row.choiceId === choice.choiceId ? { ...row, toolCap } : row) })} />
        </div>)}
        <Button type="button" size="sm" variant="outline" disabled={disabled || selection.allowedChoices.length >= 32} onClick={() => { setReplaceChoiceId(null); setChooser(!chooser); }}><Plus className="size-3.5" />{copy('Erlaubte Verbindung hinzufügen', 'Add allowed connection')}</Button>
        <label className="block space-y-1 text-xs"><span>{copy('Vorgabe', 'Default')}</span><select className={agentExtensionSelectClass} value={selection.defaultChoiceId ?? ''} disabled={disabled} onChange={event => update({ ...selection, defaultChoiceId: event.target.value || undefined })}>
          <option value="">{copy('Keine Vorgabe · persönliche Wahl nötig', 'No default · user choice required')}</option>{selection.allowedChoices.map((choice, index) => <option key={choice.choiceId} value={choice.choiceId}>{label(choice)} · {index + 1}</option>)}</select></label>
        <details className="rounded-lg border bg-background p-3"><summary className="cursor-pointer text-xs font-medium">{copy('Eigene Verbindungen erlauben', 'Allow personal connections')}</summary>
          <div className="mt-3 space-y-3"><p className="text-xs text-muted-foreground">{copy('Diese Regel erlaubt jedem Nutzer sein eigenes zulässiges Konto. Sie hinterlegt kein Erstellerkonto für andere.', 'This rule lets each user choose their own permitted account. It does not share the creator’s account.')}</p>
            {definition.alternatives.map(item => {
              const alternativeKey = extensionAlternativeKey(item), policy = selection.personalPolicy;
              const checked = policy?.alternativeKeys.includes(alternativeKey) === true;
              const setAlternativePolicy = (enabled: boolean, ids?: string[]) => {
                const keys = enabled ? [...new Set([...(policy?.alternativeKeys ?? []), alternativeKey])] : (policy?.alternativeKeys ?? []).filter(key => key !== alternativeKey);
                const sources = [...new Set(definition.alternatives.filter(candidate => keys.includes(extensionAlternativeKey(candidate))).map(candidate => candidate.source))];
                const mappings = (policy?.mcpDefinitionMappings ?? []).filter(mapping => item.source !== 'mcp' || mapping.connector !== item.connector);
                if (item.source === 'mcp' && enabled && ids?.length) mappings.push({ connector: item.connector, serverDefinitionIds: ids });
                update({ ...selection, personalPolicy: keys.length ? { sources, alternativeKeys: keys, toolCap: policy?.toolCap ?? null,
                  ...(mappings.length ? { mcpDefinitionMappings: mappings } : {}) } : undefined });
              };
              return <div className="space-y-2" key={alternativeKey}>{item.source === 'composio' ? <label className="flex items-start gap-2 text-xs"><WorkflowCheckbox checked={checked} disabled={disabled}
                onCheckedChange={enabled => setAlternativePolicy(enabled)} />{copy('Eigenes Konto: ', 'Personal account: ')}{item.toolkit}</label> : <>
                <p className="text-xs font-medium">{copy('Eigener MCP: ', 'Personal MCP: ')}{item.connector}</p>
                <AgentExtensionPersonalDefinitions context={context} disabled={disabled}
                  value={policy?.mcpDefinitionMappings?.find(mapping => mapping.connector === item.connector)?.serverDefinitionIds ?? definitionDrafts[alternativeKey] ?? []}
                  onChange={ids => { setDefinitionDrafts(previous => ({ ...previous, [alternativeKey]: ids })); setAlternativePolicy(ids.length > 0, ids); }} />
              </>}</div>;
            })}
            {selection.personalPolicy ? <AgentExtensionToolCapEditor value={selection.personalPolicy.toolCap} disabled={disabled} onChange={toolCap => update({ ...selection, personalPolicy: { ...selection.personalPolicy!, toolCap } })} /> : null}
          </div></details>
      </> : null}
      {chooser ? <div className="space-y-2"><label className="block space-y-1 text-xs"><span>{copy('Zugang', 'Connection source')}</span><select className={agentExtensionSelectClass} disabled={disabled} value={alternative} onChange={event => setAlternative(event.target.value)}>
        {definition.alternatives.map(item => <option key={extensionAlternativeKey(item)} value={extensionAlternativeKey(item)}>{extensionAlternativeKey(item)}</option>)}</select></label>
        <AgentExtensionConnectionChooser target={target} context={context} selector={{ kind: 'package', package: pin, declarationPath, capabilityId: definition.id, alternativeKey: alternative }} disabled={disabled} onSelect={choose} />
        <Button type="button" size="sm" variant="ghost" onClick={() => { setChooser(false); setReplaceChoiceId(null); setForceFixed(false); setError(null); }}>{copy('Abbrechen', 'Cancel')}</Button></div> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div> : null}
  </section>;
}
