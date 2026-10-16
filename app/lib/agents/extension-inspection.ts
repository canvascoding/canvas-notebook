import 'server-only';

import { openDb } from '@/app/lib/db';
import type { AgentManagementActor, AgentReadinessEntry } from './management-actions';
import type { AgentWorkflowManagementBindingSummary } from './workflow-management-contracts';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import { readAgentProfileOnConnection } from './registry';
import { AgentWorkflowError, isAgentWorkflowError } from './workflow-contracts';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { readIntegrationContractErrorCode } from '@/app/lib/integration-tools/agent-errors';
import { readManagedAgentWorkflow, inspectManagedAgentWorkflow } from './workflow-configuration';
import { EMAIL_MANAGED_AGENT_ID } from './storage';
import { listAgentWorkflowManagementOptions } from './workflow-management';
import { lockIntegrationConnectionBindingsOnConnection, authorizeIntegrationConnectionBindingsOnConnection } from '@/app/lib/integration-tools/connections/store';
import { agentExtensionConfigurationInputSchema, type AgentExtensionConfigurationInput,
  type ExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/contracts';
import { projectAgentStandaloneConfigurations } from '@/app/lib/capabilities/extensions/agent-standalone-configuration';
import { resolveAgentExtensionOptionsContext } from './extension-options-context';
import { readAgentExtensionStandalonePresentation } from './extension-standalone-presentation';
import type { AgentExtensionStandaloneSummary } from './extension-presentation-contracts';
import { selectAgentStandaloneExtension } from '@/app/lib/capabilities/extensions/standalone-runtime';
import { withAuthorizedCorePluginSource } from '@/app/lib/capabilities/extensions/core-source';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';

export type AgentExtensionConfigurationDescriptor = {
  agentId: string; revision: number; workflowRevision: number;
  configurationState: 'legacy' | 'available' | 'blocked';
  configuration: AgentExtensionConfigurationInput | null;
  readiness: AgentReadinessEntry[];
  /** Display metadata from the same checked management projection; no connection authority or account probe. */
  bindingSummaries?: AgentWorkflowManagementBindingSummary[];
  standaloneSummaries?: AgentExtensionStandaloneSummary[];
};

/** Safe editable identity only. Current provider health is deliberately not inferred from this metadata view. */
export async function inspectManagedAgentExtensions(actorInput: AgentManagementActor, agentId: string): Promise<AgentExtensionConfigurationDescriptor> {
  const captured = structuredClone(actorInput), preflight = await openDb();
  let actor: AgentManagementActor;
  let organizationRole: string | null;
  try {
    const current = await resolveVerifiedAgentActorContextOnConnection(captured, preflight);
    organizationRole = current.organizationRole;
    actor = { ...captured, ...current.context, organizationId: current.organizationId,
      workspaceId: current.context.workspaceId ?? null, projectId: current.context.projectId ?? null };
  } finally { await preflight.close(); }
  const before = await readManagedAgentWorkflow(actor!, agentId);
  const header = { agentId: before.agent.agentId, revision: before.agent.revision, workflowRevision: before.workflowRevision };
  if (before.workflowVersion === null) return { ...header, configurationState: 'legacy',
    configuration: { version: 1, origin: 'agent_configuration', mode: 'legacy_inherit' }, readiness: [] };
  if (before.agent.agentId === EMAIL_MANAGED_AGENT_ID && !['owner', 'admin'].includes(organizationRole! ?? '')) {
    const summary = await inspectManagedAgentWorkflow(actor!, before.agent.agentId);
    if (summary.revision !== before.agent.revision || summary.workflowRevision !== before.workflowRevision) {
      throw new AgentWorkflowError('AGENT_WORKFLOW_REVISION_CONFLICT', 'The email configuration changed. Reload its current summary.', 409);
    }
    return { ...header, configurationState: 'blocked', configuration: null,
      readiness: (summary.standalone ?? []).map(slot => ({ resourceType: 'connection', resourceId: slot.capabilityKey,
        name: slot.selectedConnection?.availability === 'available' ? slot.selectedConnection.label : slot.toolkit || slot.source,
        readiness: slot.selectedConnection?.availability === 'available' ? 'available'
          : slot.selectionOrigin === 'missing' || slot.selectionOrigin === 'stale' ? 'personal-connection-required' : 'blocked',
        reason: slot.selectedConnection?.availability === 'available' ? null : 'The exact configured connection is not currently available to this user.' })) };
  }
  // Use-only callers get the ordinary public workflow summary; editable retention hints require Edit.
  if (!before.access.canEdit) return { ...header, configurationState: 'blocked', configuration: null, readiness: [] };
  const management = await listAgentWorkflowManagementOptions(actor!, { view: 'management', agentId: before.agent.agentId });
  if (management.view !== 'management' || management.revision !== before.agent.revision || management.workflowRevision !== before.workflowRevision) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload it before editing.', 409);
  }
  const readiness: AgentReadinessEntry[] = before.bindings.map(binding => ({ resourceType: binding.resourceType,
    resourceId: binding.resourceId, name: binding.name, readiness: 'available', reason: null }));
  if (!management.configuration) {
    return { ...header, configurationState: 'blocked', configuration: null,
      readiness: readiness.map(entry => ({ ...entry, readiness: 'blocked', reason: 'A configured package or connection is no longer available for editing.' })) };
  }
  for (const binding of before.bindings) if (binding.coreConfiguration) {
    try { await withAuthorizedCorePluginSource(actor!, binding.coreConfiguration.entry.selection.coreSource, async () => undefined); }
    catch (error) {
      if (!(error instanceof CapabilityPackageError)) throw error;
      return { ...header, configurationState: 'blocked', configuration: null,
        readiness: readiness.map(entry => entry.resourceId === binding.resourceId
          ? { ...entry, readiness: 'blocked', reason: 'The selected built-in plugin source changed. Select its current source again.' } : entry) };
    }
  }
  const selections: ExtensionSelectionEntry[] = before.bindings.flatMap<ExtensionSelectionEntry>(binding => {
    if (binding.coreConfiguration) return [binding.coreConfiguration.entry];
    const pkg = binding.configuration;
    if (!pkg) return [];
    if (binding.extensionSelections) return binding.extensionSelections;
    const pin = { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum };
    return pkg.skillSelection.kind === 'plugin'
      ? [{ selection: { kind: 'plugin' as const, package: pin, skillSelection: { kind: 'all' as const } }, requirement: binding.requirement, toolCap: null }]
      : pkg.selectedSkills.map(skill => ({ selection: { kind: 'skill' as const, package: pin, relativeRoot: skill.relativeRoot,
        origin: binding.resourceType === 'skill' ? 'standalone' as const : 'plugin_child' as const }, requirement: binding.requirement, toolCap: null }));
  });
  let slots: Awaited<ReturnType<typeof projectAgentStandaloneConfigurations>>;
  let standaloneSummaries: AgentExtensionStandaloneSummary[] = [];
  try {
    const context = await resolveAgentExtensionOptionsContext(actor!, { kind: 'existing', agentId: before.agent.agentId,
      expectedRevision: before.agent.revision, expectedWorkflowRevision: before.workflowRevision });
    ({ slots, summaries: standaloneSummaries } = await readAgentExtensionStandalonePresentation(context));
    const selected = slots.flatMap(slot => slot.mode === 'fixed' ? [slot.entry.selection] : slot.allowedChoices.map(choice => choice.selection));
    const database = await openDb();
    try {
      await database.run('BEGIN');
      const verified = await resolveVerifiedAgentActorContextOnConnection(actor!, database, { lock: true });
      const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: actor!.userId, ...verified.context },
        selected.flatMap(selection => selection.target.kind === 'shared' ? [selection.target.connectionRef] : []));
      await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [before.agent.agentId]);
      const target = await readAgentProfileOnConnection(database, before.agent.agentId);
      if (!target || target.revision !== before.agent.revision || target.workflowRevision !== before.workflowRevision) {
        throw new AgentWorkflowError('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload it before editing.', 409);
      }
      const authorized = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, target, 'configure');
      for (const selection of selected) if (selection.target.kind === 'shared') {
        const exactTarget = selection.target;
        const binding = authorized.find(value => value.resource.connectionRef === exactTarget.connectionRef);
        if (!binding?.canUse || binding.resource.source !== selection.source || binding.resource.bindingRevision !== selection.target.bindingRevision
          || selection.kind === 'composio' && (binding.backend.source !== 'composio' || binding.backend.toolkit !== selection.toolkit
            || binding.backend.accountBinding === 'pending')) {
          throw new AgentWorkflowError('AGENT_WORKFLOW_BINDING_CHANGED', 'The saved exact connection changed.', 409);
        }
      }
      await database.run('COMMIT');
    } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
    finally { await database.close(); }
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    if (!(isAgentWorkflowError(error) || isIntegrationConnectionError(error) || readIntegrationContractErrorCode(error))
      || code === 'AGENT_WORKFLOW_REVISION_CONFLICT') throw error;
    return { ...header, configurationState: 'blocked', configuration: null,
      readiness: readiness.map(entry => entry.resourceType === 'connection'
        ? { ...entry, readiness: 'blocked', reason: 'The saved exact connection or its current permission changed. Select a connection again.' } : entry) };
  }
  for (const binding of before.bindings) if (binding.standaloneConfiguration) {
    const selected = selectAgentStandaloneExtension(binding.standaloneConfiguration, before, actor!.userId);
    if (!selected.choice) {
      const entry = readiness.find(value => value.resourceId === binding.resourceId);
      if (entry) { entry.readiness = 'personal-connection-required'; entry.reason = 'Choose an allowed connection for this agent in your own user scope.'; }
    }
  }
  const configuration = agentExtensionConfigurationInputSchema.parse({ version: 1, origin: 'agent_configuration', mode: 'fixed',
    selections, workflow: management.configuration.packages.length ? management.configuration : null, standalone: slots });
  return { ...header, configurationState: 'available', configuration, readiness,
    bindingSummaries: management.bindingSummaries ?? [], standaloneSummaries };
}
