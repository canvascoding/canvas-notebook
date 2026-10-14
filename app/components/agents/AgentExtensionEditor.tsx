'use client';

import type { AgentExtensionConfigurationInput } from '@/app/lib/capabilities/extensions/contracts';
import type { AgentExtensionConfigurationPreview, AgentExtensionConfigurationTarget, AgentExtensionOptionsRequest } from '@/app/lib/agents/extension-options-contracts';
import type { AgentExtensionStandaloneSummary } from '@/app/lib/agents/extension-presentation-contracts';
import type { AgentWorkflowManagementBindingSummary } from '@/app/lib/agents/workflow-management-contracts';
import { AgentExtensionEditorContent } from './AgentExtensionEditorContent';
import { clearAgentExtensionDraft } from './agent-extension-editor-draft';
import { agentExtensionEditorContextKey } from './agent-extension-options-client';

export type AgentExtensionEditorContext = { actorId?: string | null; workspaceId: string | null;
  organizationId?: string | null; projectId?: string | null };
export type AgentExtensionEditorDraft = { intent: 'keep' | 'replace'; configuration: AgentExtensionConfigurationInput | null };
export type AgentExtensionEditorValidation = { pending: boolean; blocked: boolean;
  preview: AgentExtensionConfigurationPreview | null; error: string | null };
type PreviewRequest = Extract<AgentExtensionOptionsRequest, { operation: 'preview' }>;
export type AgentExtensionEditorProps = { target: AgentExtensionConfigurationTarget; context: AgentExtensionEditorContext;
  value: AgentExtensionEditorDraft; onChange: (value: AgentExtensionEditorDraft) => void;
  enabledTools?: string[] | null; model?: Pick<PreviewRequest, 'defaultProviderInstallationId' | 'defaultProvider'
    | 'defaultModel' | 'defaultThinking' | 'expectedCatalogRevision'>; disabled?: boolean;
  onValidationChange?: (state: AgentExtensionEditorValidation) => void; suggestedSkillNames?: readonly string[];
  bindingSummaries?: readonly AgentWorkflowManagementBindingSummary[];
  standaloneSummaries?: readonly AgentExtensionStandaloneSummary[] };

/** One complete canonical draft; preview is metadata and final save always revalidates. */
export function AgentExtensionEditor(props: AgentExtensionEditorProps) {
  return <AgentExtensionEditorContent {...props} />;
}
export function clearAgentExtensionEditorDraft(context: AgentExtensionEditorContext, target: AgentExtensionConfigurationTarget): void {
  clearAgentExtensionDraft(agentExtensionEditorContextKey(context, target));
}
