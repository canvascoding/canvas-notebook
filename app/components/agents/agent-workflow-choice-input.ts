import type { AgentWorkflowCapabilityView, AgentWorkflowPersonalSelectionInput, AgentWorkflowStandaloneView } from './agent-workflow-client';
import type { StandaloneExtensionInput } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionChosenConnection } from './AgentExtensionConnectionChooser';

export type AgentWorkflowChoiceSelection = { choiceId: string | null } | { personalSelection: AgentWorkflowPersonalSelectionInput }
  | { standaloneSelection: StandaloneExtensionInput };

/** Copies only a server-returned choice into the matching slot. Current authority stays in the PATCH writer. */
export function agentWorkflowChoiceSelection(slot: AgentWorkflowCapabilityView | AgentWorkflowStandaloneView,
  choice: AgentExtensionChosenConnection): AgentWorkflowChoiceSelection {
  if (choice.choiceId) {
    if (!slot.choices.some(value => value.choiceId === choice.choiceId && value.availability === 'available')) throw new Error('WORKFLOW_CHOICE_INVALID');
    return { choiceId: choice.choiceId };
  }
  if ('source' in slot) {
    const policy = slot.personalPolicy;
    if (!policy || choice.selection.source !== slot.source || choice.selection.target.kind !== 'personal'
      || choice.selection.kind === 'composio' && choice.selection.toolkit !== slot.toolkit) throw new Error('WORKFLOW_CHOICE_INVALID');
    return { standaloneSelection: { selection: choice.selection, requirement: slot.required ? 'required' : 'optional',
      toolCap: policy.toolCap, ...(choice.accountSelectionRef ? { accountSelectionRef: choice.accountSelectionRef } : {}) } };
  }
  if (!slot.personalChoiceAllowed || !choice.packageBinding || choice.packageBinding.target.kind !== 'personal') throw new Error('WORKFLOW_CHOICE_INVALID');
  return { personalSelection: { alternativeKey: choice.packageBinding.alternativeKey, target: choice.packageBinding.target } };
}
