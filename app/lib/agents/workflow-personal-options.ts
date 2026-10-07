import 'server-only';

import { z } from 'zod';
import { openDb } from '@/app/lib/db';
import { listExistingComposioProfiles } from '@/app/lib/composio/composio-profiles';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { listPersonalWorkflowProviderAccountChoices } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { IntegrationContractError } from '@/app/lib/integration-tools/contracts';
import { assertMcpConnectionAccess, requireMcpUserAccess } from '@/app/lib/mcp/access';
import { isMcpServerEnabled, readMcpConfig } from '@/app/lib/mcp/config';
import { listMcpServerDefinitions, matchesMcpServerDefinition } from '@/app/lib/mcp/server-definitions';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import { getCapabilityPackagePublishedRevision } from '@/app/lib/capabilities/packages/store';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import type { AgentManagementActor } from './management-actions';
import { readManagedAgentWorkflow } from './workflow-configuration';
import { AgentWorkflowError, agentWorkflowCapabilityKey, type AgentWorkflowInternalSnapshot } from './workflow-contracts';
import { agentWorkflowPersonalOptionsSchema } from './workflow-api-contracts';
import type { WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';

export type AgentWorkflowPersonalOptionsRequest = z.infer<typeof agentWorkflowPersonalOptionsSchema>;
export type AgentWorkflowPersonalProviderOption = {
  providerRef: string; label: string; profileLabel?: string; origin: 'personal';
  status: 'unverified' | 'available' | 'setup_required' | 'unavailable'; noAuth?: boolean;
  accounts?: Array<{ accountSelectionRef: string; label: string; status: string; selectable: boolean }>;
};
export type AgentWorkflowPersonalOptions = {
  agentId: string; workflowRevision: number; preferenceRevision: number; capabilityKey: string;
  alternatives: Array<{ alternativeKey: string; source: 'mcp' | 'composio'; providers: AgentWorkflowPersonalProviderOption[] }>;
};

function fail(code: string, message: string, status = 403): never { throw new AgentWorkflowError(code, message, status); }
function label(value: string, fallback: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 120) || fallback; }
function integrationError(error: unknown): error is IntegrationContractError {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, Symbol.for('canvas.integration.contract-error.v1')) === true
    && ['invalid_request', 'invalid_cursor', 'provider_unavailable', 'provider_denied', 'tool_not_found', 'tool_denied', 'binding_changed',
      'schema_changed', 'invalid_arguments', 'schema_unsupported', 'outcome_unknown'].includes(Reflect.get(error, 'code')));
}
function slot(snapshot: AgentWorkflowInternalSnapshot, key: string) {
  for (const binding of snapshot.bindings) if (binding.configuration) {
    const pkg = binding.configuration;
    for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
      if (agentWorkflowCapabilityKey(pkg.resourceRef, declaration.declarationPath, capability.capabilityId) === key) return { pkg, capability };
    }
  }
  return fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose a capability from the current workflow.', 400);
}
async function permitted(actor: AgentManagementActor, request: AgentWorkflowPersonalOptionsRequest) {
  const snapshot = await readManagedAgentWorkflow(actor, request.agentId);
  if (!snapshot.access.canUse || snapshot.workflowVersion !== 1) fail('AGENT_ACCESS_DENIED', 'Current agent use is required to discover your workflow connections.');
  if (request.expectedWorkflowRevision !== undefined && request.expectedWorkflowRevision !== snapshot.workflowRevision) {
    fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The workflow configuration changed. Reload its choices.', 409);
  }
  const selected = slot(snapshot, request.capabilityKey), selection = selected.capability.selection;
  if (selection.mode !== 'selectable' || !selection.personalPolicy) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This capability does not allow personal connections.');
  const policy = selection.personalPolicy;
  const alternatives = selected.capability.alternatives.filter(alternative => {
    const key = `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
    return policy.sources.includes(alternative.source) && policy.alternativeKeys.includes(key)
      && (alternative.source !== 'composio' || isComposioIntegrationApplicationVisible(alternative.toolkit));
  });
  if (request.alternativeKey && !alternatives.some(alternative => `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}` === request.alternativeKey)) {
    fail('AGENT_WORKFLOW_CHOICE_DENIED', 'The requested integration alternative is not allowed.');
  }
  const resource = await findCapabilityResourceRecord(selected.pkg.resourceRef);
  if (!resource) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'The workflow package is unavailable.');
  await withAuthorizedCapabilityPackageResource({ userId: actor.userId, workspaceId: actor.workspaceId }, resource.storage, 'use', undefined,
    async (_authorization, database) => {
      const published = await getCapabilityPackagePublishedRevision(selected.pkg.resourceRef, selected.pkg.publishedRevisionRef, database);
      if (!published || published.checksum !== selected.pkg.checksum) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The configured package version is unavailable.', 409);
    });
  return { snapshot, policy, alternatives };
}

/** Callers authorize the exact declaration before invoking this shared own-provider enumeration. */
export async function enumerateOwnAgentWorkflowProviders(input: {
  actor: AgentManagementActor; alternatives: readonly WorkflowIntegrationAlternative[];
  mcpDefinitionMappings?: readonly { connector: string; serverDefinitionIds: readonly string[] }[]; providerRef?: string;
}): Promise<{ alternatives: AgentWorkflowPersonalOptions['alternatives']; revalidate: () => Promise<void> }> {
  const currentActor = structuredClone(input.actor), alternatives = structuredClone(input.alternatives);
  const result: AgentWorkflowPersonalOptions['alternatives'] = [];
  const profiles = alternatives.some(alternative => alternative.source === 'composio') ? await listExistingComposioProfiles(currentActor.userId) : [];
  if (profiles.length > 32) fail('AGENT_WORKFLOW_OPTIONS_UNAVAILABLE', 'Too many personal profiles are available for this chooser.', 503);
  const mcpActor = alternatives.some(alternative => alternative.source === 'mcp') ? await requireMcpUserAccess({ userId: currentActor.userId }) : null;
  const definitions = mcpActor?.organizationId ? await listMcpServerDefinitions(mcpActor.organizationId) : [];
  const mcpConfig = mcpActor ? await readMcpConfig({ userId: currentActor.userId }) : { mcpServers: {} };
  if (Object.keys(mcpConfig.mcpServers).length > 100) fail('AGENT_WORKFLOW_OPTIONS_UNAVAILABLE', 'Too many personal MCP connections are available for this chooser.', 503);
  let selectedProfile: typeof profiles[number] | undefined;
  for (const alternative of alternatives) {
    const alternativeKey = `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`;
    const providers: AgentWorkflowPersonalProviderOption[] = [];
    if (alternative.source === 'composio') {
      for (const profile of profiles) {
        if (profile.status !== 'active' || profile.ownerUserId !== currentActor.userId) continue;
        const scope = { type: 'user' as const, ownerUserId: currentActor.userId, resourceId: `profile:${profile.id}:${alternative.toolkit}` };
        const providerRef = createIntegrationProviderRef({ source: 'composio', scope, profileId: profile.id, toolkit: alternative.toolkit });
        const option: AgentWorkflowPersonalProviderOption = { providerRef, label: label(profile.name, 'Personal Composio profile'),
          profileLabel: label(profile.name, 'Personal Composio profile'), origin: 'personal', status: 'unverified' };
        if (input.providerRef === providerRef) selectedProfile = profile;
        providers.push(option);
      }
    } else {
      const mapped = input.mcpDefinitionMappings?.find(mapping => mapping.connector === alternative.connector)?.serverDefinitionIds ?? [];
      const approved = new Map(definitions.filter(definition => definition.enabled && mapped.includes(definition.id)).map(definition => [definition.id, definition]));
      for (const [serverName, connection] of Object.entries(mcpConfig.mcpServers)) {
        const definition = connection.serverDefinitionId ? approved.get(connection.serverDefinitionId) : undefined;
        if (!definition || !connection.connectionId || !isMcpServerEnabled(connection) || connection.ownerUserId !== currentActor.userId
          || connection.organizationId !== mcpActor?.organizationId || !matchesMcpServerDefinition(connection, definition)) continue;
        await assertMcpConnectionAccess(connection.connectionId, { userId: currentActor.userId }, { actor: mcpActor });
        const scope = { type: 'user' as const, resourceId: connection.connectionId, ownerUserId: currentActor.userId };
        const providerRef = createIntegrationProviderRef({ source: 'mcp', scope, connectionId: connection.connectionId });
        providers.push({ providerRef, label: label(connection.displayName || serverName, 'Personal MCP connection'), origin: 'personal', status: 'unverified' });
      }
    }
    if (input.providerRef) {
      const selected = providers.find(provider => provider.providerRef === input.providerRef);
      if (!selected) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'The selected personal provider is not allowed.');
      if (alternative.source === 'composio') {
        try {
          const choices = await listPersonalWorkflowProviderAccountChoices({ actor: currentActor, providerRef: selected.providerRef,
            exactToolkit: { profileId: selectedProfile!.id, toolkit: alternative.toolkit } });
          selected.noAuth = choices.noAuth; selected.accounts = choices.accounts.map(account => ({ ...account,
            label: label(account.label, 'App account'), status: ['ACTIVE', 'INITIATED', 'INACTIVE', 'EXPIRED', 'FAILED', 'REVOKED'].includes(account.status)
              ? account.status : 'UNKNOWN' }));
          selected.status = choices.noAuth || choices.accounts.some(account => account.selectable) ? 'available' : 'setup_required';
        } catch (error) {
          if (!integrationError(error)) throw error;
          if (error.code === 'binding_changed') fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The personal connection changed. Reload its choices.', 409);
          fail(error.code === 'provider_denied' ? 'AGENT_WORKFLOW_CHOICE_DENIED' : 'AGENT_WORKFLOW_OPTIONS_UNAVAILABLE',
            error.code === 'provider_denied' ? 'The selected personal connection is unavailable.' : 'The selected integration is unavailable. Review its connection settings.',
            error.code === 'provider_denied' ? 403 : 503);
        }
      }
      providers.splice(0, providers.length, selected);
    }
    result.push({ alternativeKey, source: alternative.source, providers });
  }
  return { alternatives: result, revalidate: async () => {
    if (selectedProfile) {
      const current = (await listExistingComposioProfiles(currentActor.userId)).find(profile => profile.id === selectedProfile.id);
      if (!current || current.ownerUserId !== selectedProfile.ownerUserId || current.composioUserId !== selectedProfile.composioUserId
        || current.updatedAt.getTime() !== selectedProfile.updatedAt.getTime()) {
        fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The selected personal profile changed. Reload its choices.', 409);
      }
    }
  } };
}

/** Discovery has no provider I/O until the user selects an already permitted exact provider. */
export async function listAgentWorkflowPersonalOptions(actorInput: AgentManagementActor,
  unknownRequest: AgentWorkflowPersonalOptionsRequest): Promise<AgentWorkflowPersonalOptions> {
  const actor = structuredClone(actorInput), parsed = agentWorkflowPersonalOptionsSchema.safeParse(unknownRequest);
  if (!parsed.success) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'The personal discovery request is invalid.', 400);
  const request = parsed.data, initial = await permitted(actor, request);
  const database = await openDb();
  let currentActor: AgentManagementActor;
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database);
    currentActor = { ...actor, organizationId: verified.organizationId, workspaceId: verified.context.workspaceId, projectId: verified.context.projectId };
  } finally { await database.close(); }
  const alternatives = initial.alternatives.filter(alternative => !request.alternativeKey
    || `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}` === request.alternativeKey);
  const providers = await enumerateOwnAgentWorkflowProviders({ actor: currentActor, alternatives,
    mcpDefinitionMappings: initial.policy.mcpDefinitionMappings, providerRef: request.providerRef });
  const final = await permitted(currentActor, { ...request, expectedWorkflowRevision: initial.snapshot.workflowRevision });
  if (final.snapshot.agent.revision !== initial.snapshot.agent.revision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload its choices.', 409);
  await providers.revalidate();
  return { agentId: initial.snapshot.agent.agentId, workflowRevision: initial.snapshot.workflowRevision,
    preferenceRevision: initial.snapshot.preferenceRevision, capabilityKey: request.capabilityKey, alternatives: providers.alternatives };
}
