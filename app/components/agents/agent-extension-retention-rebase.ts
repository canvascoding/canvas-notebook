import { agentExtensionConfigurationInputSchema, type AgentExtensionConfigurationInput } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionEditorDraft } from './AgentExtensionEditor';

export class AgentExtensionRetentionRebaseError extends Error {
  constructor() { super('The saved connection configuration changed. Reload before saving.'); this.name = 'AgentExtensionRetentionRebaseError'; }
}
function withoutRetentions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRetentions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'retainedBindingRef').map(([key, child]) => [key, withoutRetentions(child)]));
  return value;
}
function references(configuration: AgentExtensionConfigurationInput): Array<{ key: string; value: { retainedBindingRef: string } }> {
  if (configuration.mode !== 'fixed') return [];
  const result: Array<{ key: string; value: { retainedBindingRef: string } }> = [];
  for (const pkg of configuration.workflow?.packages ?? []) for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
    const choices = capability.selection.mode === 'fixed' ? [{ choiceId: null, ...capability.selection }] : capability.selection.allowedChoices;
    for (const choice of choices) if (choice.target.kind === 'retained') result.push({
      key: JSON.stringify(['package', pkg.resourceRef, pkg.publishedRevisionRef, pkg.checksum, declaration.declarationPath,
        capability.capabilityId, capability.selection.mode, choice.choiceId, choice.alternativeKey]), value: choice.target,
    });
  }
  for (const slot of configuration.standalone) {
    const choices = slot.mode === 'fixed' ? [slot.entry] : slot.allowedChoices;
    for (const choice of choices) if (choice.retainedBindingRef !== undefined) result.push({
      key: JSON.stringify(['standalone', slot.configurationId, slot.mode, 'choiceId' in choice ? choice.choiceId : null, choice.selection]),
      value: choice as typeof choice & { retainedBindingRef: string },
    });
  }
  return result;
}

/** Refresh display/edit hints only. Source/actor/CAS checks belong to the genuine inspection and writer. */
export function rebaseAgentExtensionRetentions(input: { draft: AgentExtensionEditorDraft;
  before: AgentExtensionConfigurationInput | null; current: AgentExtensionConfigurationInput | null }): AgentExtensionEditorDraft {
  if (!input.before || !input.current) throw new AgentExtensionRetentionRebaseError();
  const before = agentExtensionConfigurationInputSchema.parse(input.before), current = agentExtensionConfigurationInputSchema.parse(input.current);
  if (JSON.stringify(withoutRetentions(before)) !== JSON.stringify(withoutRetentions(current))) throw new AgentExtensionRetentionRebaseError();
  if (input.draft.intent === 'keep') return { intent: 'keep', configuration: current };
  if (!input.draft.configuration) throw new AgentExtensionRetentionRebaseError();
  const next = agentExtensionConfigurationInputSchema.parse(input.draft.configuration);
  const previous = new Map(references(before).map(row => [row.key, row.value.retainedBindingRef]));
  const fresh = new Map(references(current).map(row => [row.key, row.value.retainedBindingRef]));
  for (const row of references(next)) {
    const replacement = fresh.get(row.key);
    if (!replacement || previous.get(row.key) !== row.value.retainedBindingRef) throw new AgentExtensionRetentionRebaseError();
    row.value.retainedBindingRef = replacement;
  }
  return { intent: 'replace', configuration: next };
}
