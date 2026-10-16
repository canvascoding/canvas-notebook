import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { IntegrationConnectionBindingBatch } from '@/app/lib/integration-tools/connections/store';
import type { RenderedExtensionContext } from '@/app/lib/capabilities/extensions/context-prompt';
import { getAgentAccessOnConnection } from './access';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import type { AgentManagementActor } from './management-actions';
import { AgentWorkflowError } from './workflow-contracts';
import { readAgentWorkflowPreferenceSnapshot, readManagedAgentWorkflowOnConnection } from './workflow-configuration';
import { buildAgentExtensionPackageContextOnConnection } from './extension-context-package-metadata';
import { buildAgentExtensionProviderContextOnConnection } from './extension-context-provider-metadata';
import { compileAgentExtensionConfigurationContext } from './extension-context-compiler';

export type AgentExtensionConfigurationContextCheck = Readonly<{
  fingerprint: string;
  budget: RenderedExtensionContext['budget'];
  runtimeReadiness: 'not_checked';
  providerHealth: 'unknown';
}>;

/**
 * Final configuration check, before COMMIT, against the actual pending SQL row.
 * This compiles metadata only: it issues no Runtime selection, session, read
 * root or provider authority. The caller holds source locks before the Agent
 * row and retains the actual connection batch for this same transaction.
 */
export async function assertManagedAgentExtensionContextOnConnection(input: {
  database: SqlConnection;
  actor: AgentManagementActor;
  agentId: string;
  batch: IntegrationConnectionBindingBatch;
  purpose: 'configure' | 'read';
}): Promise<AgentExtensionConfigurationContextCheck | null> {
  const { database, batch, purpose } = input;
  const verified = await resolveVerifiedAgentActorContextOnConnection(input.actor, database, { lock: true });
  const actor: AgentManagementActor = { ...input.actor, organizationId: verified.context.organizationId,
    workspaceId: verified.context.workspaceId ?? null, projectId: verified.context.projectId ?? null };
  const snapshot = await readManagedAgentWorkflowOnConnection(database, input.agentId);
  if (snapshot.workflowVersion !== 2) return null;
  const access = await getAgentAccessOnConnection(database, actor.userId, snapshot.agent.agentId, verified.context);
  if (snapshot.agent.type === 'main' || !(purpose === 'configure' ? access.canEdit : access.canUse)) {
    throw new AgentWorkflowError('AGENT_ACCESS_DENIED', 'Current Agent access is required for this configuration check.', 403);
  }
  const preferences = readAgentWorkflowPreferenceSnapshot(await database.get(
    'SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
    [snapshot.agent.agentId, actor.userId]) as Record<string, unknown> | undefined);
  if (Object.values(preferences.choices).some(choice => choice.personalTarget?.kind === 'personal'
    && choice.personalTarget.ownerUserId !== actor.userId)) {
    throw new AgentWorkflowError('AGENT_WORKFLOW_CORRUPT', 'Stored personal choices are unavailable.', 409);
  }
  // Local configuration data, deliberately never registered as a runtime proof.
  snapshot.choices = preferences.choices;
  snapshot.preferenceRevision = preferences.revision;
  const packageContext = await buildAgentExtensionPackageContextOnConnection({ database, actor, snapshot });
  const { projection: workflowProjection, requiredProviders } = await buildAgentExtensionProviderContextOnConnection({
    database, actor: verified, snapshot, batch, purpose, packages: packageContext.configurations });
  const sourceFingerprint = createHash('sha256').update(JSON.stringify([snapshot.agent.agentId, snapshot.agent.revision,
    snapshot.workflowRevision, snapshot.preferenceRevision, packageContext.fingerprint, workflowProjection])).digest('hex');
  const compiled = await compileAgentExtensionConfigurationContext({ actorUserId: actor.userId, runtimeFields: snapshot.agent,
    workspacePermissions: verified.workspacePermissions ? { canWrite: verified.workspacePermissions.canWrite,
      canDelete: verified.workspacePermissions.canDelete, canShare: verified.workspacePermissions.canCreatePublicLinks } : null,
    presentation: { fingerprint: sourceFingerprint, mode: 'fixed', packages: packageContext.packages, corePackages: packageContext.corePackages,
      skills: packageContext.skills, workflowProjection }, requiredProviders });
  return Object.freeze({ fingerprint: compiled.fingerprint, budget: compiled.rendered.budget,
    runtimeReadiness: 'not_checked', providerHealth: 'unknown' });
}
