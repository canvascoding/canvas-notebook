import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { IntegrationConnectionBindingBatch } from '@/app/lib/integration-tools/connections/store';
import { intersectIntegrationPolicies, isIntegrationProviderOperationAllowed } from '@/app/lib/integration-tools/policy';
import { EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS, renderEffectiveExtensionContext,
  type RenderedExtensionContext } from '@/app/lib/capabilities/extensions/context-prompt';
import { buildPiSpecialAgentRegistrationMetadata } from '@/app/lib/pi/tool-registry';
import type { EffectiveToolManifest } from '@/app/lib/pi/effective-tool-manifest';
import { getAgentAccessOnConnection } from './access';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import { resolveSpecialAgentRuntimeSettings } from './effective-runtime-config';
import type { AgentManagementActor } from './management-actions';
import { AgentWorkflowError } from './workflow-contracts';
import { readAgentWorkflowPreferenceSnapshot, readManagedAgentWorkflowOnConnection } from './workflow-configuration';
import { buildAgentExtensionPackageContextOnConnection } from './extension-context-package-metadata';
import { buildAgentExtensionProviderContextOnConnection } from './extension-context-provider-metadata';

export type AgentExtensionConfigurationContextCheck = Readonly<{
  fingerprint: string;
  budget: RenderedExtensionContext['budget'];
  runtimeReadiness: 'not_checked';
  providerHealth: 'unknown';
}>;

function registered(manifest: EffectiveToolManifest, operation: string): boolean {
  return manifest.registeredToolNames.includes(operation) || manifest.gateways.some(gateway =>
    manifest.registeredToolNames.includes(gateway.toolName) && gateway.allowedOperationNames.includes(operation));
}

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
  const settings = await resolveSpecialAgentRuntimeSettings(snapshot.agent);
  const registration = await buildPiSpecialAgentRegistrationMetadata({ kind: 'special', userId: actor.userId,
    effectiveEnabledTools: settings.enabledTools, extensionMode: 'fixed', workspacePermissions: verified.workspacePermissions
      ? { canWrite: verified.workspacePermissions.canWrite, canDelete: verified.workspacePermissions.canDelete,
        canShare: verified.workspacePermissions.canCreatePublicLinks } : null });
  const packageContext = await buildAgentExtensionPackageContextOnConnection({ database, actor, snapshot });
  const { projection: workflowProjection, requiredProviders } = await buildAgentExtensionProviderContextOnConnection({
    database, actor: verified, snapshot, batch, purpose, packages: packageContext.configurations });
  if ((packageContext.packages.some(pkg => pkg.skills.length > 0)
    || packageContext.skills.some(skill => skill.required && !skill.core)) && !registered(registration.manifest, 'read')) {
    throw new AgentWorkflowError('AGENT_EXTENSION_READ_TOOL_REQUIRED',
      'Enable the skill reading tool before assigning these published skills.', 409);
  }
  if (requiredProviders.length > 0 && !workflowProjection.unavailable) {
    const ceiling = registration.integrationPolicyCeiling;
    const policy = ceiling ? intersectIntegrationPolicies(ceiling, workflowProjection.policy) : null;
    if (!registration.manifest.registeredToolNames.includes('integrations') || !policy
      || requiredProviders.some(provider => !isIntegrationProviderOperationAllowed(policy,
        provider.source, provider.providerRef, 'search_tools') || !isIntegrationProviderOperationAllowed(policy,
        provider.source, provider.providerRef, 'describe'))) {
      throw new AgentWorkflowError('AGENT_EXTENSION_DISCOVERY_TOOLS_REQUIRED',
        'Enable the tool search and schema tools needed by this required connection.', 409);
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([snapshot.agent.agentId, snapshot.agent.revision,
    snapshot.workflowRevision, snapshot.preferenceRevision, packageContext.fingerprint, workflowProjection,
    registration.manifest, registration.integrationPolicyCeiling])).digest('hex');
  // The mandatory recipes repeat taskQuery for discovery and selected providers.
  // A lone UTF-16 surrogate takes six escaped ASCII bytes in JSON, exceeding
  // a valid four-byte code point. Reserve that true maximum for each recipe.
  // Optional detail ranking still varies with the real task and the Runtime
  // guard remains necessary for later source or actor changes.
  const reservedTaskQuery = '\ud800'.repeat(EXTENSION_CONTEXT_QUERY_MAX_CODEPOINTS);
  const rendered = renderEffectiveExtensionContext({ fingerprint, mode: 'fixed', packages: packageContext.packages,
    skills: packageContext.skills, workflowProjection }, registration.manifest, reservedTaskQuery,
  { integrationPolicyCeiling: registration.integrationPolicyCeiling ?? undefined });
  return Object.freeze({ fingerprint, budget: rendered.budget, runtimeReadiness: 'not_checked', providerHealth: 'unknown' });
}
