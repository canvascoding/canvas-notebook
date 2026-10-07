'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { WorkflowCheckbox as Checkbox } from './WorkflowCheckbox';
import type { WorkflowIntegrationAlternative, WorkflowIntegrationCapability } from '@/app/lib/capabilities/workflow-contracts';
import type { AgentWorkflowManagement, AgentWorkflowManagementHeader, AgentWorkflowManagementPackageVersion } from '@/app/lib/agents/workflow-management-contracts';
import type { AgentWorkflowManagementContext } from './agent-workflow-management-client';
import { deriveActiveWorkflowDeclarations, type AgentWorkflowManagementDraft, type WorkflowDraftCapability,
  type WorkflowDraftSelection, type WorkflowDraftPackage } from './agent-workflow-management-draft';
import { useWorkflowManagementOptions } from './use-workflow-management-options';
import { WorkflowTargetSelector, type WorkflowTargetSlot } from './WorkflowTargetSelector';

const inputClass = 'h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const key = (alternative: WorkflowIntegrationAlternative) => `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
function ToolCap({ value, disabled, onChange }: { value: string[] | null; disabled: boolean; onChange: (value: string[] | null) => void }) {
  const t = useTranslations('agentWorkflowManagement');
  const [editing, setEditing] = useState({ valueKey: JSON.stringify(value), text: value?.join('\n') ?? '' });
  const text = editing.valueKey === JSON.stringify(value) ? editing.text : value?.join('\n') ?? '';
  return <details className="rounded-md border p-3"><summary className="cursor-pointer text-xs font-medium">{t('bindings.toolLimits')}</summary>
    <div className="mt-3 space-y-3"><label className="flex items-start gap-2 text-xs"><Checkbox checked={value !== null} disabled={disabled}
      onCheckedChange={checked => onChange(checked === true ? [] : null)} /><span>{t('bindings.limitTools')}</span></label>
      {value !== null ? <label className="block space-y-1.5 text-xs"><span>{t('bindings.toolNames')}</span>
        <textarea className="min-h-20 w-full min-w-0 rounded-md border bg-background p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('bindings.toolNames')} disabled={disabled} maxLength={65_536} value={text}
          onChange={event => { const next = event.target.value.split(/[\n,]/u).map(name => name.trim()).filter(Boolean);
            setEditing({ valueKey: JSON.stringify(next), text: event.target.value }); onChange(next); }} /></label>
        : <p className="text-xs text-muted-foreground">{t('bindings.inheritToolLimits')}</p>}
    </div>
  </details>;
}

function PersonalPolicy({ selection, alternatives, context, header, slot, disabled, onChange, onAuthorityError }: {
  selection: Extract<WorkflowDraftSelection, { mode: 'selectable' }>; alternatives: readonly WorkflowIntegrationAlternative[];
  context: AgentWorkflowManagementContext; header: AgentWorkflowManagementHeader; slot: Omit<WorkflowTargetSlot, 'alternativeKey'>;
  disabled: boolean; onChange: (selection: WorkflowDraftSelection) => void; onAuthorityError: (error: 'conflict' | 'denied') => void;
}) {
  const t = useTranslations('agentWorkflowManagement'), read = useWorkflowManagementOptions(context, onAuthorityError);
  const [definitions, setDefinitions] = useState<Record<string, Array<{ definitionId: string; label: string }>>>({});
  const policy = selection.personalPolicy;
  const changeAlternative = (alternative: WorkflowIntegrationAlternative, checked: boolean) => {
    const alternativeKeys = checked ? [...new Set([...(policy?.alternativeKeys ?? []), key(alternative)])] : (policy?.alternativeKeys ?? []).filter(value => value !== key(alternative));
    const sources = [...new Set(alternatives.filter(value => alternativeKeys.includes(key(value))).map(value => value.source))];
    onChange({ ...selection, personalPolicy: { sources, alternativeKeys, toolCap: policy?.toolCap ?? null,
      ...(policy?.mcpDefinitionMappings ? { mcpDefinitionMappings: policy.mcpDefinitionMappings } : {}) } });
  };
  return <div className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="workflow-management-personal-policy">
    <label className="flex items-start gap-2 text-sm"><Checkbox checked={Boolean(policy)} disabled={disabled}
      onCheckedChange={checked => onChange(checked === true ? { ...selection, personalPolicy: { sources: [], alternativeKeys: [], toolCap: null } }
        : { mode: 'selectable', allowedChoices: selection.allowedChoices, ...(selection.defaultChoiceId ? { defaultChoiceId: selection.defaultChoiceId } : {}) })} />
      <span>{t('bindings.allowPersonal')}</span></label>
    {policy ? <>
      <p className="text-xs text-muted-foreground">{t('bindings.personalPolicyHint')}</p>
      {alternatives.map(alternative => <div key={key(alternative)} className="space-y-2">
        <label className="flex items-start gap-2 text-sm"><Checkbox disabled={disabled} checked={policy.alternativeKeys.includes(key(alternative))}
          aria-label={t('bindings.allowAlternative', { alternative: key(alternative) })} onCheckedChange={value => changeAlternative(alternative, value === true)} />
          <span>{key(alternative)}</span></label>
        {alternative.source === 'mcp' && policy.alternativeKeys.includes(key(alternative)) ? <div className="space-y-2 pl-6">
          <Button type="button" size="sm" variant="outline" disabled={disabled || read.loading} onClick={async () => {
            const result = await read.run({ view: 'personal-mcp-definitions', agentId: header.agentId, expectedRevision: header.revision,
              expectedWorkflowRevision: header.workflowRevision, ...slot, alternativeKey: key(alternative) });
            if (result?.view === 'personal-mcp-definitions') setDefinitions(previous => ({ ...previous, [key(alternative)]: result.definitions }));
          }}>{t('bindings.loadDefinitions')}</Button>
          {definitions[key(alternative)]?.map(definition => {
            const mappings = policy.mcpDefinitionMappings ?? [], ids = mappings.find(value => value.connector === alternative.connector)?.serverDefinitionIds ?? [];
            return <label key={definition.definitionId} className="flex items-center gap-2 text-xs"><Checkbox disabled={disabled} checked={ids.includes(definition.definitionId)}
              aria-label={t('bindings.definition', { name: definition.label })} onCheckedChange={value => onChange({ ...selection, personalPolicy: { ...policy,
                mcpDefinitionMappings: [...mappings.filter(mapping => mapping.connector !== alternative.connector), { connector: alternative.connector,
                  serverDefinitionIds: value === true ? [...ids, definition.definitionId] : ids.filter(id => id !== definition.definitionId) }] } })} />{definition.label}</label>;
          })}
        </div> : null}
      </div>)}
      {read.loading ? <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-3 animate-spin" />{t('loading')}</p> : null}
      {read.error ? <p role="alert" className="text-xs">{t(`errors.${read.error}`)}</p> : null}
      <ToolCap value={policy.toolCap} disabled={disabled} onChange={value => onChange({ ...selection, personalPolicy: { ...policy, toolCap: value } })} />
    </> : null}
  </div>;
}

function CapabilityForm({ definition, capability, context, header, pkg, declarationPath, disabled, ownerUserId, onChange, onAuthorityError }: {
  definition: WorkflowIntegrationCapability; capability: WorkflowDraftCapability; context: AgentWorkflowManagementContext;
  header: AgentWorkflowManagement; pkg: WorkflowDraftPackage; declarationPath: string; disabled: boolean; ownerUserId: string | null;
  onChange: (capability: WorkflowDraftCapability) => void; onAuthorityError: (error: 'conflict' | 'denied') => void;
}) {
  const t = useTranslations('agentWorkflowManagement'), selection = capability.selection;
  const baseSlot = { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, declarationPath, capabilityId: capability.capabilityId };
  const update = (next: WorkflowDraftSelection | null) => onChange({ ...capability, selection: next });
  const allowPersonal = header.agentId === context.agentId && Boolean(ownerUserId) && (!context.actorId || ownerUserId === context.actorId);
  const target = (choice: { alternativeKey: string; target: import('@/app/lib/agents/workflow-contracts').AgentWorkflowTarget | null },
    change: (target: typeof choice.target) => void, choiceId?: string) => <WorkflowTargetSelector
      key={JSON.stringify([baseSlot, choice.alternativeKey, choiceId ?? null])} context={context} header={header}
      slot={{ ...baseSlot, alternativeKey: choice.alternativeKey }} target={choice.target} disabled={disabled} allowPersonal={allowPersonal}
      ownerUserId={ownerUserId} onChange={change} onAuthorityError={onAuthorityError}
      summary={header.bindingSummaries?.find(value => value.resourceRef === pkg.resourceRef && value.publishedRevisionRef === pkg.publishedRevisionRef
        && value.declarationPath === declarationPath && value.capabilityId === capability.capabilityId && value.alternativeKey === choice.alternativeKey
        && value.choiceId === choiceId && choice.target?.kind === 'retained')} />;
  return <section className="min-w-0 space-y-3 rounded-xl border p-3 sm:p-4" data-testid="workflow-management-capability">
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h4 className="break-words text-sm font-semibold capitalize">{definition.application}</h4>
      <p className="mt-1 break-words text-xs text-muted-foreground">{definition.id}</p></div>
      <label className="flex items-center gap-2 text-xs"><Checkbox checked={definition.required || capability.required} disabled={disabled || definition.required}
        aria-label={t('bindings.requiredFor', { application: definition.application })} onCheckedChange={value => onChange({ ...capability, required: value === true })} />{t('bindings.required')}</label>
    </div>
    <label className="block space-y-1.5 text-xs font-medium"><span>{t('bindings.mode')}</span>
      <select className={inputClass} aria-label={t('bindings.modeFor', { application: definition.application })} disabled={disabled} value={selection?.mode ?? 'none'}
        onChange={event => update(event.target.value === 'fixed' ? { mode: 'fixed', alternativeKey: key(definition.alternatives[0]), toolCap: null, target: null }
          : event.target.value === 'selectable' ? { mode: 'selectable', allowedChoices: [] } : null)}>
        <option value="none" disabled={definition.required || capability.required}>{t('bindings.notAssigned')}</option>
        <option value="fixed">{t('bindings.fixed')}</option><option value="selectable">{t('bindings.selectable')}</option>
      </select>
    </label>
    {selection?.mode === 'fixed' ? <>
      <label className="block space-y-1.5 text-xs font-medium"><span>{t('bindings.alternative')}</span>
        <select className={inputClass} aria-label={t('bindings.alternative')} value={selection.alternativeKey} disabled={disabled}
          onChange={event => update({ ...selection, alternativeKey: event.target.value, target: null })}>
          {definition.alternatives.map(value => <option key={key(value)} value={key(value)}>{key(value)}</option>)}
        </select>
      </label>
      {target(selection, value => update({ ...selection, target: value }))}
      <ToolCap value={selection.toolCap} disabled={disabled} onChange={value => update({ ...selection, toolCap: value })} />
    </> : null}
    {selection?.mode === 'selectable' ? <>
      {selection.allowedChoices.map((choice, index) => <div key={choice.choiceId} className="space-y-3 rounded-lg border p-3" data-testid="workflow-management-choice">
        <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">{t('bindings.choiceNumber', { number: index + 1 })}</p>
          <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={t('bindings.removeChoice')} onClick={() => update({ ...selection,
            allowedChoices: selection.allowedChoices.filter(value => value.choiceId !== choice.choiceId),
            defaultChoiceId: selection.defaultChoiceId === choice.choiceId ? undefined : selection.defaultChoiceId })}><Trash2 className="size-3.5" /></Button></div>
        <label className="block space-y-1.5 text-xs"><span>{t('bindings.alternative')}</span>
          <select className={inputClass} aria-label={t('bindings.alternative')} disabled={disabled} value={choice.alternativeKey}
            onChange={event => update({ ...selection, allowedChoices: selection.allowedChoices.map(value => value.choiceId === choice.choiceId
              ? { ...value, alternativeKey: event.target.value, target: null } : value) })}>
            {definition.alternatives.map(value => <option key={key(value)} value={key(value)}>{key(value)}</option>)}
          </select>
        </label>
        {target(choice, next => update({ ...selection, allowedChoices: selection.allowedChoices.map(value => value.choiceId === choice.choiceId ? { ...value, target: next } : value) }), choice.choiceId)}
        <ToolCap value={choice.toolCap} disabled={disabled} onChange={next => update({ ...selection,
          allowedChoices: selection.allowedChoices.map(value => value.choiceId === choice.choiceId ? { ...value, toolCap: next } : value) })} />
      </div>)}
      <Button type="button" size="sm" variant="outline" disabled={disabled || selection.allowedChoices.length >= 32}
        onClick={() => update({ ...selection, allowedChoices: [...selection.allowedChoices, { choiceId: `choice-${crypto.randomUUID()}`,
          alternativeKey: key(definition.alternatives[0]), target: null, toolCap: null }] })}><Plus className="size-3.5" />{t('bindings.addChoice')}</Button>
      <label className="block space-y-1.5 text-xs font-medium"><span>{t('bindings.default')}</span>
        <select className={inputClass} aria-label={t('bindings.default')} disabled={disabled} value={selection.defaultChoiceId ?? ''}
          onChange={event => update({ ...selection, defaultChoiceId: event.target.value || undefined })}>
          <option value="">{t('bindings.noDefault')}</option>{selection.allowedChoices.map((choice, index) => <option key={choice.choiceId} value={choice.choiceId} disabled={!choice.target}>{t('bindings.choiceNumber', { number: index + 1 })}</option>)}
        </select>
      </label>
      <PersonalPolicy selection={selection} alternatives={definition.alternatives} context={context} header={header} slot={baseSlot} disabled={disabled}
        onChange={update} onAuthorityError={onAuthorityError} />
    </> : null}
  </section>;
}

export function WorkflowCapabilityBindingSection({ draft, context, disabled, ownerUserId, onCacheVersion, onChangePackage, onAuthorityError }: {
  draft: AgentWorkflowManagementDraft; context: AgentWorkflowManagementContext; disabled: boolean; ownerUserId: string | null;
  onCacheVersion: (version: AgentWorkflowManagementPackageVersion) => void; onChangePackage: (pkg: WorkflowDraftPackage) => void;
  onAuthorityError: (error: 'conflict' | 'denied') => void;
}) {
  const t = useTranslations('agentWorkflowManagement'), read = useWorkflowManagementOptions(context, onAuthorityError), header = draft.base;
  return <div className="min-w-0 space-y-4" data-testid="workflow-management-bindings">
    <p className="text-xs leading-relaxed text-muted-foreground">{t('bindings.authorityHint')}</p>
    {draft.packages.map(pkg => {
      const version = draft.packageVersions[pkg.resourceRef];
      const metadata = version && version.publishedRevisionRef === pkg.publishedRevisionRef && version.checksum === pkg.checksum ? version : undefined;
      const declarations = metadata ? deriveActiveWorkflowDeclarations(metadata, pkg.skillSelection) : [];
      return <div key={pkg.resourceRef} className="min-w-0 space-y-3 rounded-lg bg-muted/20 p-3">
        <p className="break-words text-sm font-medium">{metadata?.name ?? t('packages.configured')}</p>
        {!metadata ? <Button type="button" variant="outline" size="sm" disabled={disabled || read.loading} onClick={async () => {
          const result = await read.run({ view: 'package-version', agentId: header.agentId, expectedRevision: header.revision,
            expectedWorkflowRevision: header.workflowRevision, resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef });
          if (result?.view === 'package-version') onCacheVersion(result);
        }}>{read.loading ? <Loader2 className="size-3.5 animate-spin" /> : null}{t('bindings.load')}</Button> : null}
        {metadata && !declarations.length ? <p className="text-xs text-muted-foreground">{t('bindings.noDeclarations')}</p> : null}
        {declarations.map(declaration => <div key={declaration.declarationPath} className="space-y-3">
          <p className="break-words text-xs text-muted-foreground">{declaration.declarationPath}</p>
          {declaration.workflow.integrationCapabilities.map(definition => {
            const current = pkg.declarations.find(value => value.declarationPath === declaration.declarationPath)?.capabilities.find(value => value.capabilityId === definition.id)
              ?? { capabilityId: definition.id, required: definition.required, selection: null };
            return <CapabilityForm key={definition.id} definition={definition} capability={current} context={context} header={header} pkg={pkg}
              declarationPath={declaration.declarationPath} disabled={disabled} ownerUserId={header.profile.scopeType === 'user' ? ownerUserId : null}
              onAuthorityError={onAuthorityError} onChange={next => {
                const copy = structuredClone(pkg), existing = copy.declarations.find(value => value.declarationPath === declaration.declarationPath);
                if (!existing) copy.declarations.push({ declarationPath: declaration.declarationPath, capabilities: [next] });
                else { const index = existing.capabilities.findIndex(value => value.capabilityId === next.capabilityId); if (index < 0) existing.capabilities.push(next); else existing.capabilities[index] = next; }
                onChangePackage(copy);
              }} />;
          })}
        </div>)}
      </div>;
    })}
    {read.error ? <p role="alert" className="text-xs">{t(`errors.${read.error}`)}</p> : null}
    {!draft.packages.length ? <p className="text-sm text-muted-foreground">{t('bindings.noPackages')}</p> : null}
  </div>;
}
