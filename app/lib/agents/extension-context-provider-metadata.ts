import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { IntegrationPolicy, IntegrationProviderDescriptor, IntegrationProviderToolRule } from '@/app/lib/integration-tools/contracts';
import { authorizeIntegrationConnectionBindingsOnConnection, prepareEmailV2BindingConfigurationOnConnection, narrowIntegrationConnectionBindingBatchOnConnection,
  type IntegrationConnectionBindingAuthorization, type IntegrationConnectionBindingBatch } from '@/app/lib/integration-tools/connections/store';
import { presentSharedIntegrationProvider } from '@/app/lib/integration-tools/connections/provider-policy';
import { presentPersonalWorkflowProvider } from '@/app/lib/integration-tools/workflow-provider-presentation';
import { validatePersonalWorkflowProviderBinding } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { createIntegrationProviderRef } from '@/app/lib/integration-tools/references';
import { schemaFingerprint } from '@/app/lib/integration-tools/schema';
import { readExistingConfig } from '@/app/lib/mcp/read-only-config';
import { hashMcpLegacyConfig, validateMcpConnectionId } from '@/app/lib/mcp/connection-identity';
import { listMcpServerDefinitions, matchesMcpServerDefinition } from '@/app/lib/mcp/server-definitions';
import { resolveOrganizationDataRoot, resolveUserMcpDir } from '@/app/lib/runtime-data-paths';
import { getComposioMode } from '@/app/lib/composio/composio-client';
import { selectAgentStandaloneExtension, type AgentStandaloneRuntimeSelection } from '@/app/lib/capabilities/extensions/standalone-runtime';
import { intersectPackageExtensionToolCaps } from '@/app/lib/capabilities/packages/extension-projection';
import { getSelectedAgentWorkflowCapability } from './workflow-configuration';
import { resolveVerifiedAgentActorContextOnConnection, type VerifiedAgentActorContext } from './actor-context';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot, type StoredAgentWorkflowPackage, type StoredAgentWorkflowTarget } from './workflow-contracts';
import type { AgentWorkflowRuntimeProjection } from './workflow-runtime';
import { EMAIL_MANAGED_AGENT_ID } from './storage';

const OPERATIONS = ['list_providers', 'search_providers', 'list_tools', 'search_tools', 'describe', 'call'] as const;
type RequiredProvider = Readonly<{ source: 'mcp' | 'composio'; providerRef: string }>;
export type AgentExtensionProviderContext = Readonly<{
  projection: AgentWorkflowRuntimeProjection;
  requiredProviders: readonly RequiredProvider[];
}>;
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
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
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
  const bound = `${binding.source}:v1:personal:${createHash('sha256').update(JSON.stringify(binding)).digest('hex')}`;
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
  return presentPersonalWorkflowProvider({ binding, baseProviderRef: base, boundProviderRef: bound,
    bindingFingerprint: target.bindingFingerprint }, displayName);
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
  let unavailable = chosen.some(entry => entry.capability.required && !entry.selected);
  const missingStandalone = selectedStandalone.some(entry => entry.required && !entry.choice);
  const selectedShared = unavailable ? [] : [...chosen.flatMap(entry => entry.selected?.target.kind === 'shared' ? [entry.selected.target.connectionRef] : []),
    ...(!missingStandalone ? selectedStandalone.flatMap(entry => entry.choice?.target.kind === 'shared' ? [entry.choice.target.connectionRef] : []) : [])];
  const batch = await narrowIntegrationConnectionBindingBatchOnConnection(database, input.batch, []);
  const emailV2Configuration = input.purpose === 'configure' && snapshot.agent.agentId === EMAIL_MANAGED_AGENT_ID
    ? await prepareEmailV2BindingConfigurationOnConnection(database, batch, snapshot.agent) : undefined;
  await authorizeIntegrationConnectionBindingsOnConnection(database, batch, snapshot.agent, input.purpose,
    emailV2Configuration ? { emailV2Configuration } : {});
  const authorized: IntegrationConnectionBindingAuthorization[] = [];
  for (const reference of new Set(selectedShared)) {
    const selectedBatch = await narrowIntegrationConnectionBindingBatchOnConnection(database, input.batch, [reference]);
    const selectedEmail = emailV2Configuration
      ? await prepareEmailV2BindingConfigurationOnConnection(database, selectedBatch, snapshot.agent) : undefined;
    try {
      authorized.push(...await authorizeIntegrationConnectionBindingsOnConnection(database, selectedBatch, snapshot.agent, input.purpose,
        selectedEmail ? { emailV2Configuration: selectedEmail } : {}));
    } catch { /* A denied optional source is omitted, as in the actual runtime projection. */ }
  }
  const shared = new Map(authorized.map(value => [value.resource.connectionRef, value]));
  const descriptors = new Map<string, IntegrationProviderDescriptor>();
  const rules = new Map<string, IntegrationProviderToolRule>();
  const required = new Map<string, RequiredProvider>();
  const standaloneSelections: AgentStandaloneRuntimeSelection[] = selectedStandalone.map(selected => ({
    configurationId: selected.configurationId, slotRef: selected.slotRef, source: selected.source,
    required: selected.required, origin: selected.origin, state: selected.choice ? 'selected' : selected.origin === 'stale' ? 'stale' : 'missing',
    ...(selected.choice ? { selection: selected.choice.selection } : {}),
  }));
  const include = async (target: StoredAgentWorkflowTarget, cap: readonly string[] | null, isRequired: boolean,
    expected?: { source: 'mcp' | 'composio'; toolkit?: string; connector?: string; requiredTools?: readonly string[] }): Promise<string> => {
    if (expected && (target.source !== expected.source || expected.source === 'composio' && target.kind === 'personal'
      && (target.personalBinding?.source !== 'composio' || target.personalBinding.toolkit !== expected.toolkit))) invalid();
    const authorization = target.kind === 'shared' ? shared.get(target.connectionRef) : undefined;
    if (target.kind === 'shared' && (!authorization || expected?.source === 'composio'
      && (authorization.backend.source !== 'composio' || authorization.backend.toolkit !== expected.toolkit))) invalid();
    const descriptor = target.kind === 'shared' ? await sharedMetadata(input, authorization!, target, expected?.connector)
      : await personalMetadata(input, target);
    const permitted = intersectPackageExtensionToolCaps(cap, authorization?.allowedToolNames ?? null);
    const prior = rules.get(descriptor.providerRef);
    if (prior && prior.source !== descriptor.source) invalid();
    const names = prior ? prior.allowedToolNames === null || permitted === null ? null
      : [...new Set([...prior.allowedToolNames, ...permitted])].sort() : permitted;
    rules.set(descriptor.providerRef, { source: descriptor.source, providerRef: descriptor.providerRef, allowedToolNames: names,
      allowedOperations: names?.length === 0 ? OPERATIONS.filter(operation => operation !== 'call') : [...OPERATIONS] });
    descriptors.set(descriptor.providerRef, descriptor);
    if (isRequired) required.set(descriptor.providerRef, { source: descriptor.source, providerRef: descriptor.providerRef });
    return descriptor.providerRef;
  };
  if (!unavailable) for (const { capability, selected } of chosen) {
    if (!selected) { unavailable ||= capability.required; continue; }
    const alternative = capability.alternatives.find(value => `${value.source}:${value.source === 'mcp' ? value.connector : value.toolkit}` === selected.alternativeKey);
    try {
      if (!alternative) invalid();
      await include(selected.target, selected.toolCap, capability.required, alternative.source === 'mcp'
        ? { source: 'mcp', connector: alternative.connector, requiredTools: alternative.requiredTools }
        : { source: 'composio', toolkit: alternative.toolkit, requiredTools: alternative.requiredTools });
    } catch { if (capability.required) { unavailable = true; break; } }
  }
  if (!missingStandalone && !unavailable) for (let index = 0; index < selectedStandalone.length; index++) {
    const selected = selectedStandalone[index], summary = standaloneSelections[index];
    if (selected.choice) try {
      const providerRef = await include(selected.choice.target, selected.choice.toolCap, selected.required);
      standaloneSelections[index] = { ...summary, providerRef };
    } catch { unavailable ||= selected.required; standaloneSelections[index] = { ...summary, state: 'unavailable' }; }
  }
  unavailable ||= missingStandalone;
  const policy: IntegrationPolicy = { allowedSources: null, allowedProviderRefs: null, allowedApplications: null,
    allowedToolNames: null, allowedOperations: null, providerToolRules: unavailable ? [] : [...rules.values()].sort((a, b) => a.providerRef.localeCompare(b.providerRef)) };
  const projection: AgentWorkflowRuntimeProjection = { policy, revision: schemaFingerprint([snapshot.agent.revision, snapshot.workflowRevision,
    snapshot.preferenceRevision, input.packages, authorized.map(value => value.authorizationRevision), standaloneSelections, policy, unavailable]),
  selectedProviders: unavailable ? [] : [...descriptors.values()], standaloneSelections, unavailable };
  return freeze({ projection, requiredProviders: unavailable ? [] : [...required.values()] });
}
