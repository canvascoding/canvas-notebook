import 'server-only';

import path from 'node:path';
import type { SqlConnection } from '@/app/lib/db';
import type { IntegrationProviderDescriptor } from '@/app/lib/integration-tools/contracts';
import { authorizeIntegrationConnectionBindingsOnConnection, prepareEmailV2BindingConfigurationOnConnection, narrowIntegrationConnectionBindingBatchOnConnection,
  type IntegrationConnectionBindingAuthorization, type IntegrationConnectionBindingBatch } from '@/app/lib/integration-tools/connections/store';
import { presentSharedIntegrationProvider } from '@/app/lib/integration-tools/connections/provider-policy';
import { createPersonalWorkflowProviderMetadataReference, presentPersonalWorkflowProvider } from '@/app/lib/integration-tools/workflow-provider-presentation';
import { validatePersonalWorkflowProviderBinding } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { readExistingConfig } from '@/app/lib/mcp/read-only-config';
import { hashMcpLegacyConfig, validateMcpConnectionId } from '@/app/lib/mcp/connection-identity';
import { listMcpServerDefinitions, matchesMcpServerDefinition } from '@/app/lib/mcp/server-definitions';
import { resolveOrganizationDataRoot, resolveUserMcpDir } from '@/app/lib/runtime-data-paths';
import { getComposioMode } from '@/app/lib/composio/composio-client';
import { selectAgentStandaloneExtension } from '@/app/lib/capabilities/extensions/standalone-runtime';
import { intersectPackageExtensionToolCaps } from '@/app/lib/capabilities/packages/extension-projection';
import { getSelectedAgentWorkflowCapability } from './workflow-configuration';
import { resolveVerifiedAgentActorContextOnConnection, type VerifiedAgentActorContext } from './actor-context';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot, type StoredAgentWorkflowPackage, type StoredAgentWorkflowTarget } from './workflow-contracts';
import { EMAIL_MANAGED_AGENT_ID } from './storage';
import { projectAgentExtensionProviderContext, type AgentExtensionProviderContext } from './extension-provider-context-projection';

export type { AgentExtensionProviderContext } from './extension-provider-context-projection';
type Input = {
  database: SqlConnection;
  actor: VerifiedAgentActorContext;
  snapshot: AgentWorkflowInternalSnapshot;
  /** Source-checked, mask/cap-projected configurations from the package metadata assembler. */
  packages: readonly StoredAgentWorkflowPackage[];
  batch: IntegrationConnectionBindingBatch;
  purpose: 'configure' | 'read';
};

function invalid(): never {
  throw new AgentWorkflowError('AGENT_WORKFLOW_BINDING_INVALID', 'The configured extension metadata cannot be verified.', 409);
}
function targets(pkg: StoredAgentWorkflowPackage): StoredAgentWorkflowTarget[] {
  return pkg.declarations.flatMap(declaration => declaration.capabilities.flatMap(capability =>
    capability.selection.mode === 'fixed' ? [capability.selection.target] : capability.selection.allowedChoices.map(choice => choice.target)));
}

/** All finite choices must be locked, including unselected/default and per-user shared choices. */
export function collectAgentExtensionContextSharedReferences(snapshot: AgentWorkflowInternalSnapshot): readonly string[] {
  const references = new Set<string>();
  const add = (target: StoredAgentWorkflowTarget) => { if (target.kind === 'shared') references.add(target.connectionRef); };
  for (const binding of snapshot.bindings) {
    if (binding.configuration) targets(binding.configuration).forEach(add);
    const standalone = binding.standaloneConfiguration;
    if (standalone) (standalone.mode === 'fixed' ? [standalone.entry] : standalone.allowedChoices).forEach(choice => add(choice.target));
  }
  return Object.freeze([...references].sort());
}

async function sharedMetadata(input: Input, authorization: IntegrationConnectionBindingAuthorization,
  target: Extract<StoredAgentWorkflowTarget, { kind: 'shared' }>, packageConnector?: string): Promise<IntegrationProviderDescriptor> {
  const { resource, backend } = authorization;
  if (!authorization.canUse || resource.status !== 'active' || resource.source !== target.source || backend.source !== target.source
    || resource.bindingRevision !== target.bindingRevision || resource.connectionRef !== target.connectionRef
    || authorization.actor.userId !== input.actor.userId
    || authorization.actor.organizationId && authorization.actor.organizationId !== input.actor.organizationId
    || (authorization.actor.workspaceId ?? null) !== (input.actor.context.workspaceId ?? null)) invalid();
  if (backend.source === 'composio') {
    if (backend.accountBinding === 'pending' || backend.toolkit !== resource.application) invalid();
  } else if (packageConnector !== undefined) {
    validateMcpConnectionId(backend.connectionId);
    const file = path.join(resolveOrganizationDataRoot(resource.ownership.organizationId), 'mcp', 'shared', backend.connectionId, 'config.json');
    const servers = Object.values((await readExistingConfig(file)).mcpServers);
    const connection = servers[0];
    if (servers.length !== 1 || !connection || connection.connectionId !== backend.connectionId || connection.ownerUserId
      || connection.organizationId !== resource.ownership.organizationId || connection.enabled === false) invalid();
    const definitions = connection.serverDefinitionId ? await listMcpServerDefinitions(resource.ownership.organizationId) : [];
    const definition = definitions.find(item => item.id === connection.serverDefinitionId);
    if (connection.serverDefinitionId && (!definition?.enabled || !matchesMcpServerDefinition(connection, definition))) invalid();
    const mapping = target.verifiedMcpMapping;
    if (!mapping || mapping.connector !== packageConnector || hashMcpLegacyConfig(connection) !== mapping.configFingerprint
      || mapping.definitionId !== (connection.serverDefinitionId ?? null)
      || mapping.definitionId && (!definition?.enabled || definition.revision !== mapping.definitionRevision)) invalid();
  }
  return presentSharedIntegrationProvider(resource);
}

async function personalMetadata(input: Input, target: Extract<StoredAgentWorkflowTarget, { kind: 'personal' }>): Promise<IntegrationProviderDescriptor> {
  const binding = validatePersonalWorkflowProviderBinding(target.personalBinding);
  if (binding.ownerUserId !== input.actor.userId || target.ownerUserId !== input.actor.userId || target.source !== binding.source
    || !target.bindingFingerprint || !/^[a-f0-9]{64}$/u.test(target.bindingFingerprint)) invalid();
  const base = binding.source === 'mcp'
    ? createIntegrationProviderRef({ source: 'mcp', connectionId: binding.connectionId,
      scope: { type: 'user', ownerUserId: binding.ownerUserId, resourceId: binding.connectionId } })
    : createIntegrationProviderRef({ source: 'composio', profileId: binding.profileId, toolkit: binding.toolkit,
      scope: { type: 'user', ownerUserId: binding.ownerUserId, resourceId: `profile:${binding.profileId}:${binding.toolkit}` } });
  const bound = createPersonalWorkflowProviderMetadataReference(binding);
  if (target.providerRef !== base || target.boundProviderRef !== bound) invalid();
  let displayName: string;
  if (binding.source === 'composio') {
    const profile = await input.database.get('SELECT owner_user_id,scope_type,status,name FROM composio_connection_profiles WHERE id=$1 FOR SHARE',
      [binding.profileId]) as Record<string, unknown> | undefined;
    if (!profile || profile.owner_user_id !== binding.ownerUserId || profile.scope_type !== 'user' || profile.status !== 'active'
      || await getComposioMode({ secretScope: 'user', userId: binding.ownerUserId }) !== binding.mode) invalid();
    displayName = `${binding.toolkit} · ${typeof profile.name === 'string' ? profile.name : 'Personal connection'}`;
  } else {
    const matches = Object.entries((await readExistingConfig(path.join(resolveUserMcpDir(binding.ownerUserId), 'config.json'))).mcpServers)
      .filter(([, connection]) => connection.connectionId === binding.connectionId);
    const match = matches[0], connection = match?.[1];
    if (matches.length !== 1 || !match || !connection || connection.ownerUserId !== binding.ownerUserId
      || (connection.serverDefinitionId ?? null) !== binding.serverDefinitionId
      || connection.organizationId && connection.organizationId !== input.actor.organizationId
      || input.actor.organizationId && input.actor.organizationRole === 'external') invalid();
    if (binding.serverDefinitionId) {
      if (!connection.organizationId || connection.organizationId !== input.actor.organizationId) invalid();
      const definition = (await listMcpServerDefinitions(connection.organizationId)).find(item => item.id === binding.serverDefinitionId);
      if (!definition?.enabled || !matchesMcpServerDefinition(connection, definition)) invalid();
    } else if (!['owner', 'admin'].includes(input.actor.organizationRole ?? '')) {
      // In an unconfigured installation the actual global administrator owns the personal source.
      const user = !input.actor.organizationId
        ? await input.database.get('SELECT role FROM "user" WHERE id=$1', [input.actor.userId]) as { role?: unknown } | undefined
        : undefined;
      if (input.actor.organizationId || !user || !['owner', 'admin'].includes(String(user.role))) invalid();
    }
    displayName = typeof connection.displayName === 'string' && connection.displayName ? connection.displayName : match[0];
  }
  return presentPersonalWorkflowProvider({ binding, boundProviderRef: bound }, displayName);
}

/** Pending SQL configuration presentation only. No runtime proof, session, provider request or account selection is issued. */
export async function buildAgentExtensionProviderContextOnConnection(input: Input): Promise<AgentExtensionProviderContext> {
  const { database, actor, snapshot } = input;
  const current = await resolveVerifiedAgentActorContextOnConnection({ userId: actor.userId, ...actor.context }, database, { lock: true });
  if (JSON.stringify(current) !== JSON.stringify(actor)) invalid();
  const requiredRefs = collectAgentExtensionContextSharedReferences(snapshot);
  if (requiredRefs.some(ref => !input.batch.connectionRefs.includes(ref))) invalid();
  const chosen = input.packages.flatMap(pkg => pkg.declarations.flatMap(declaration => declaration.capabilities.map(capability => ({
    capability, selected: getSelectedAgentWorkflowCapability(snapshot, pkg, declaration, capability),
  }))));
  const selectedStandalone = snapshot.bindings.flatMap(binding => binding.standaloneConfiguration
    ? [selectAgentStandaloneExtension(binding.standaloneConfiguration, snapshot, actor.userId)] : []);
  const batch = await narrowIntegrationConnectionBindingBatchOnConnection(database, input.batch, []);
  const emailV2Configuration = input.purpose === 'configure' && snapshot.agent.agentId === EMAIL_MANAGED_AGENT_ID
    ? await prepareEmailV2BindingConfigurationOnConnection(database, batch, snapshot.agent) : undefined;
  await authorizeIntegrationConnectionBindingsOnConnection(database, batch, snapshot.agent, input.purpose,
    emailV2Configuration ? { emailV2Configuration } : {});
  const shared = new Map<string, Promise<IntegrationConnectionBindingAuthorization>>();
  const authorityRevisions: string[] = [];
  const authorizationFor = (reference: string): Promise<IntegrationConnectionBindingAuthorization> => {
    let authorization = shared.get(reference);
    if (!authorization) {
      authorization = (async () => {
        const selectedBatch = await narrowIntegrationConnectionBindingBatchOnConnection(database, input.batch, [reference]);
        const selectedEmail = emailV2Configuration
          ? await prepareEmailV2BindingConfigurationOnConnection(database, selectedBatch, snapshot.agent) : undefined;
        const [actual] = await authorizeIntegrationConnectionBindingsOnConnection(database, selectedBatch, snapshot.agent, input.purpose,
          selectedEmail ? { emailV2Configuration: selectedEmail } : {});
        if (!actual) invalid();
        authorityRevisions.push(actual.authorizationRevision);
        return actual;
      })();
      shared.set(reference, authorization);
    }
    return authorization;
  };
  const resolve = async (target: StoredAgentWorkflowTarget, cap: readonly string[] | null,
    expected?: { source: 'mcp' | 'composio'; toolkit?: string; connector?: string }) => {
    if (expected && (target.source !== expected.source || expected.source === 'composio' && target.kind === 'personal'
      && (target.personalBinding?.source !== 'composio' || target.personalBinding.toolkit !== expected.toolkit))) invalid();
    const authorization = target.kind === 'shared' ? await authorizationFor(target.connectionRef) : undefined;
    if (target.kind === 'shared' && (!authorization || expected?.source === 'composio'
      && (authorization.backend.source !== 'composio' || authorization.backend.toolkit !== expected.toolkit))) invalid();
    const descriptor = target.kind === 'shared' ? await sharedMetadata(input, authorization!, target, expected?.connector)
      : await personalMetadata(input, target);
    return { descriptor, toolCap: intersectPackageExtensionToolCaps(cap, authorization?.allowedToolNames ?? null) };
  };
  return projectAgentExtensionProviderContext({
    capabilities: chosen.map(({ capability, selected }) => ({ required: capability.required, choice: selected ? { resolve: async () => {
      const alternative = capability.alternatives.find(value => `${value.source}:${value.source === 'mcp' ? value.connector : value.toolkit}` === selected.alternativeKey);
      if (!alternative) invalid();
      return resolve(selected.target, selected.toolCap, alternative.source === 'mcp'
        ? { source: 'mcp', connector: alternative.connector } : { source: 'composio', toolkit: alternative.toolkit });
    } } : null })),
    standalone: selectedStandalone.map(selected => ({ summary: {
      configurationId: selected.configurationId, slotRef: selected.slotRef, source: selected.source, required: selected.required, origin: selected.origin,
      state: selected.choice ? 'selected' : selected.origin === 'stale' ? 'stale' : 'missing',
      ...(selected.choice ? { selection: selected.choice.selection } : {}),
    }, choice: selected.choice ? { resolve: () => resolve(selected.choice!.target, selected.choice!.toolCap) } : null })),
    revisionSeed: [snapshot.agent.revision, snapshot.workflowRevision, snapshot.preferenceRevision, input.packages, authorityRevisions],
  });
}
