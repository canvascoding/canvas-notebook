import 'server-only';

import path from 'node:path';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveCapabilityPackageArtifact, validateCompleteCapabilityPackage } from '@/app/lib/capabilities/packages/artifacts';
import { getCapabilityPackagePublishedRevision, findCapabilityPackageStateForStorage } from '@/app/lib/capabilities/packages/store';
import { resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot } from '@/app/lib/capabilities/packages/io';
import type { CapabilityPackagePublishedRevision } from '@/app/lib/capabilities/packages/contracts';
import { withAuthorizedCapabilityPackageResource, findCapabilityResourceRecord, getCapabilityResourceAccess } from '@/app/lib/capabilities/resources/store';
import type { CapabilityResourceStorageBinding } from '@/app/lib/capabilities/resources/contracts';
import { parsePluginSkillsFromManifest } from '@/app/lib/plugins/canvas-plugin-registry';
import { parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';
import type { WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import { lockIntegrationConnectionBindingsOnConnection, authorizeIntegrationConnectionBindingsOnConnection,
  type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { resolveSharedMcpBackend } from '@/app/lib/mcp/shared-connections';
import { readMcpConfig } from '@/app/lib/mcp/config';
import { hashMcpLegacyConfig } from '@/app/lib/mcp/connection-identity';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import type { McpScope } from '@/app/lib/mcp/scope';
import { parseAgentDefaultFields, parseAgentDefaultCatalogRevision, validateAgentDefaultOnConnection } from '@/app/lib/agent-runtime-policy/agent-default-service';
import { assertBrowserToolCanBeEnabled } from '@/app/lib/pi/browser/settings-service';
import { isAgentActorContextError, resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import { getAgentAccessOnConnection } from './access';
import { readAgentProfileOnConnection, updateAgentProfile, AgentRevisionConflictError, type AgentProfile } from './registry';
import { listRawAgentCapabilityBindings, replaceAgentCapabilityBindings, type AgentCapabilityBindingInput } from './capability-bindings';
import { auditAgentAction, validateSpecialAgentTools, resolveCapabilityBindings, type AgentManagementActor } from './management-actions';
import { normalizeAgentIconId } from './icons';
import { EMAIL_MANAGED_AGENT_ID } from './storage';
import { AgentWorkflowError, parseAgentWorkflowConfiguration, parseStoredAgentWorkflowTarget, agentWorkflowCapabilityKey,
  agentWorkflowTargetSchema, type AgentWorkflowPackageConfiguration, type AgentWorkflowDescriptor, type AgentWorkflowInternalSnapshot,
  type AgentWorkflowChoice, type AgentWorkflowTarget, type StoredAgentWorkflowTarget, type StoredAgentWorkflowPackage,
  type UpdateManagedAgentConfigurationInput, type AgentWorkflowConnectionOption } from './workflow-contracts';

type PreparedPersonal = Awaited<ReturnType<typeof import('@/app/lib/integration-tools/workflow-personal-bindings').preparePersonalWorkflowProviderTarget>>;
type PreparedPackage = { stored: StoredAgentWorkflowPackage; storage: CapabilityResourceStorageBinding; published: CapabilityPackagePublishedRevision };
type PreparedTargets = { personal: PreparedPersonal[]; mcp: Array<{ target: StoredAgentWorkflowTarget; scope: McpScope; connectionId: string }> };
const host = globalThis as typeof globalThis & { __canvasManagedAgentWorkflowSnapshotsV1?: WeakSet<object> };
const snapshots = host.__canvasManagedAgentWorkflowSnapshotsV1 ??= new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value;
}
function fail(code: string, message: string, status = 409): never { throw new AgentWorkflowError(code, message, status); }
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail('AGENT_WORKFLOW_REVISION_REQUIRED', 'A current workflow revision is required.', 400); return Number(value); }
function alternativeKey(alternative: WorkflowIntegrationAlternative): string { return `${alternative.source}:${alternative.source === 'mcp' ? alternative.connector : alternative.toolkit}`; }
function targets(configuration: StoredAgentWorkflowPackage): StoredAgentWorkflowTarget[] {
  return configuration.declarations.flatMap(declaration => declaration.capabilities.flatMap(capability => capability.selection.mode === 'fixed'
    ? [capability.selection.target] : capability.selection.allowedChoices.map(choice => choice.target)));
}
function references(packages: readonly PreparedPackage[]): string[] {
  return packages.flatMap(entry => targets(entry.stored).flatMap(target => target.kind === 'shared' ? [target.connectionRef] : []));
}

/** Global agent grants remain conditional on their currently reachable scope. */
async function holdAgentGrantAuthority(database: SqlConnection, actor: AgentManagementActor, agent: AgentProfile): Promise<void> {
  const grants = await database.all('SELECT id,target_type,target_id FROM agent_grants WHERE agent_id=$1 ORDER BY id FOR SHARE', [agent.agentId]) as Array<{ target_type: string; target_id: string }>;
  await database.all('SELECT user_id FROM agent_members WHERE agent_id=$1 ORDER BY user_id FOR SHARE', [agent.agentId]);
  if (actor.workspaceId || !agent.organizationId) return;
  const targets = grants.filter(grant => grant.target_type === 'workspace' || grant.target_type === 'project')
    .sort((left, right) => `${left.target_type}:${left.target_id}`.localeCompare(`${right.target_type}:${right.target_id}`));
  for (const target of targets) {
    try {
      await resolveVerifiedAgentActorContextOnConnection({ userId: actor.userId, organizationId: agent.organizationId,
        ...(target.target_type === 'workspace' ? { workspaceId: target.target_id } : { projectId: target.target_id }) }, database, { lock: true });
    } catch (error) { if (!isAgentActorContextError(error)) throw error; }
  }
}

/** Raw internal reader: SQL NULL alone denotes legacy; unknown versions and corrupted JSON never do. */
export async function readManagedAgentWorkflowOnConnection(database: SqlConnection, agentId: string): Promise<AgentWorkflowInternalSnapshot> {
  const agent = await readAgentProfileOnConnection(database, agentId);
  if (!agent) fail('AGENT_NOT_FOUND', 'Agent not found.', 404);
  const version = agent.workflowVersion, workflowRevision = revision(agent.workflowRevision ?? 0);
  if (version !== null && version !== undefined && version !== 1) fail('AGENT_WORKFLOW_CORRUPT', 'The stored workflow version is unavailable.');
  const bindings = await listRawAgentCapabilityBindings(agent.agentId, database);
  if (version == null && bindings.some(binding => binding.configuration !== null)
    || version === 1 && (workflowRevision < 1 || bindings.some(binding => binding.resourceType !== 'connection' && binding.configuration === null))) {
    fail('AGENT_WORKFLOW_CORRUPT', 'The stored workflow header and package bindings do not match.');
  }
  return { agent, workflowVersion: version === 1 ? 1 : null, workflowRevision, bindings, preferenceRevision: 0, choices: {}, access: { canUse: false, canEdit: false, canManage: false } };
}

function preferenceSnapshot(row: Record<string, unknown> | undefined): { revision: number; json: Record<string, unknown>; choices: Record<string, AgentWorkflowChoice> } {
  if (!row) return { revision: 0, json: {}, choices: {} };
  const currentRevision = revision(Number(row.revision));
  if (currentRevision < 1) fail('AGENT_WORKFLOW_CORRUPT', 'The stored choice revision is invalid.');
  let json: Record<string, unknown>;
  if (typeof row.preferences_json !== 'string' || Buffer.byteLength(row.preferences_json) > 1_048_576) fail('AGENT_WORKFLOW_CORRUPT', 'Stored preferences are unavailable.');
  try { json = JSON.parse(String(row.preferences_json)); } catch { return fail('AGENT_WORKFLOW_CORRUPT', 'Stored preferences are unavailable.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('AGENT_WORKFLOW_CORRUPT', 'Stored preferences are unavailable.');
  const choices = json.workflowChoices === undefined ? {} : json.workflowChoices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices) || Object.keys(choices).length > 4_096) fail('AGENT_WORKFLOW_CORRUPT', 'Stored workflow choices are unavailable.');
  for (const [key, value] of Object.entries(choices)) {
    if (!/^agent-capability:[A-Za-z0-9_-]{43}$/u.test(key) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !['workflowRevision', 'choiceId', 'personalTarget', 'alternativeKey'].includes(field))) {
      fail('AGENT_WORKFLOW_CORRUPT', 'Stored workflow choices are unavailable.');
    }
    const choice = value as AgentWorkflowChoice;
    if (revision(choice.workflowRevision) < 1) fail('AGENT_WORKFLOW_CORRUPT', 'Stored workflow choices are unavailable.');
    if (choice.choiceId !== undefined && (typeof choice.choiceId !== 'string' || !choice.choiceId || choice.choiceId.length > 256 || choice.choiceId !== choice.choiceId.trim() || /[\u0000-\u001f\u007f]/u.test(choice.choiceId))
      || choice.personalTarget && choice.choiceId !== undefined || choice.personalTarget && choice.personalTarget.kind !== 'personal') fail('AGENT_WORKFLOW_CORRUPT', 'Stored workflow choices are unavailable.');
    if (choice.personalTarget) {
      choice.personalTarget = parseStoredAgentWorkflowTarget(choice.personalTarget);
      if (typeof choice.alternativeKey !== 'string' || choice.alternativeKey.length > 256) fail('AGENT_WORKFLOW_CORRUPT', 'Stored workflow choices are unavailable.');
    } else if (choice.choiceId === undefined || choice.alternativeKey !== undefined) fail('AGENT_WORKFLOW_CORRUPT', 'Stored workflow choices are unavailable.');
  }
  return { revision: currentRevision, json, choices: choices as Record<string, AgentWorkflowChoice> };
}

/** Fresh actor/agent authority. This private result must never be spread into an HTTP or tool DTO. */
export async function readManagedAgentWorkflow(actorInput: AgentManagementActor, agentId: string): Promise<AgentWorkflowInternalSnapshot> {
  const actor = structuredClone(actorInput), database = await openDb();
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database);
    const result = await readManagedAgentWorkflowOnConnection(database, agentId);
    const access = await getAgentAccessOnConnection(database, actor.userId, result.agent.agentId, verified.context);
    if (!access.canUse && !access.canEdit && !access.canManage) fail('AGENT_ACCESS_DENIED', 'Agent access denied.', 403);
    result.access = { ...access };
    const preferences = preferenceSnapshot(await database.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2',
      [result.agent.agentId, actor.userId]) as Record<string, unknown> | undefined);
    if (Object.values(preferences.choices).some(choice => choice.personalTarget?.kind === 'personal' && choice.personalTarget.ownerUserId !== actor.userId)) {
      fail('AGENT_WORKFLOW_CORRUPT', 'Stored personal choices are unavailable.');
    }
    result.preferenceRevision = preferences.revision; result.choices = structuredClone(preferences.choices);
    freeze(result); snapshots.add(result); return result;
  } finally { await database.close(); }
}
export function isManagedAgentWorkflowSnapshot(value: unknown): value is AgentWorkflowInternalSnapshot { return Boolean(value && typeof value === 'object' && snapshots.has(value)); }

export function getSelectedAgentWorkflowCapability(snapshot: AgentWorkflowInternalSnapshot, pkg: StoredAgentWorkflowPackage,
  declaration: StoredAgentWorkflowPackage['declarations'][number], capability: StoredAgentWorkflowPackage['declarations'][number]['capabilities'][number]):
  { alternativeKey: string; target: StoredAgentWorkflowTarget; toolCap: string[] | null } | null {
  const selection = capability.selection;
  if (selection.mode === 'fixed') return selection;
  const choice = snapshot.choices[agentWorkflowCapabilityKey(pkg.resourceRef, declaration.declarationPath, capability.capabilityId)];
  if (choice) {
    if (choice.workflowRevision !== snapshot.workflowRevision) return null;
    if (choice.choiceId !== undefined) return selection.allowedChoices.find(candidate => candidate.choiceId === choice.choiceId) ?? null;
    const policy = selection.personalPolicy;
    if (!choice.personalTarget || !policy || !choice.alternativeKey || !policy.sources.includes(choice.personalTarget.source) || !policy.alternativeKeys.includes(choice.alternativeKey)) return null;
    return { alternativeKey: choice.alternativeKey, target: choice.personalTarget, toolCap: policy.toolCap };
  }
  return selection.defaultChoiceId ? selection.allowedChoices.find(candidate => candidate.choiceId === selection.defaultChoiceId) ?? null : null;
}

async function prepareTarget(actor: AgentManagementActor, target: AgentWorkflowTarget, alternative: WorkflowIntegrationAlternative,
  prepared: PreparedTargets): Promise<StoredAgentWorkflowTarget> {
  if (target.source !== alternative.source) fail('AGENT_WORKFLOW_BINDING_INVALID', 'The selected source does not match this declared alternative.');
  if (target.kind === 'personal') {
    if (target.ownerUserId !== actor.userId) fail('AGENT_WORKFLOW_BINDING_DENIED', 'Choose your own personal connection.', 403);
    const helpers = await import('@/app/lib/integration-tools/workflow-personal-bindings');
    const proof = await helpers.preparePersonalWorkflowProviderTarget({ actor, providerRef: target.providerRef, accountSelectionRef: target.accountSelectionRef,
      ...(alternative.source === 'composio' ? { toolkit: alternative.toolkit } : {}) });
    const verified = helpers.getPreparedPersonalWorkflowProviderTarget(proof);
    if (verified.binding.source !== target.source || verified.binding.ownerUserId !== actor.userId
      || alternative.source === 'composio' && (verified.binding.source !== 'composio' || verified.binding.toolkit !== alternative.toolkit)) {
      fail('AGENT_WORKFLOW_BINDING_INVALID', 'The selected personal provider does not match the declared application.');
    }
    prepared.personal.push(proof);
    return { kind: 'personal', source: target.source, ownerUserId: actor.userId, providerRef: verified.baseProviderRef,
      boundProviderRef: verified.boundProviderRef, bindingFingerprint: verified.bindingFingerprint, personalBinding: verified.binding };
  }
  const stored: StoredAgentWorkflowTarget = structuredClone(target);
  if (alternative.source === 'mcp') {
    // Mapping is an explicit management act, not an application/display-name guess.
    const backend = await resolveSharedMcpBackend({ userId: actor.userId, workspaceId: actor.workspaceId, organizationId: actor.organizationId }, target.connectionRef, 'manage');
    if (backend.authorization.resource.bindingRevision !== target.bindingRevision) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected MCP binding changed.');
    const definition = backend.connection.serverDefinitionId
      ? (await listMcpServerDefinitions(backend.authorization.resource.ownership.organizationId)).find(entry => entry.id === backend.connection.serverDefinitionId) : null;
    if (!definition && !target.mcpMapping) fail('AGENT_WORKFLOW_MAPPING_REQUIRED', 'Confirm the exact managed MCP connection for this declared connector.');
    stored.verifiedMcpMapping = { connector: alternative.connector, configFingerprint: hashMcpLegacyConfig(backend.connection),
      definitionId: definition?.id ?? null, definitionRevision: definition?.revision ?? null, confirmedByUserId: actor.userId };
    prepared.mcp.push({ target: stored, scope: backend.scope, connectionId: backend.connection.connectionId });
  }
  return stored;
}

async function preparePackage(actor: AgentManagementActor, input: AgentWorkflowPackageConfiguration, prepared: PreparedTargets): Promise<PreparedPackage> {
  const source = await resolveCapabilityPackageArtifact({ userId: actor.userId, workspaceId: actor.workspaceId }, input.resourceRef);
  if (source.storage.sourceType === 'plugin') fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'Select the published parent package and its exact child roots.');
  if (!source.descriptor.access.canUse || source.descriptor.activation?.effectivePolicy === 'blocked' || source.descriptor.activation?.readiness === 'conflict') {
    fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is not permitted for this actor.', 403);
  }
  const published = await withAuthorizedCapabilityPackageResource({ userId: actor.userId, workspaceId: actor.workspaceId }, source.storage, 'use', undefined,
    async (_authorization, database) => {
      const state = await findCapabilityPackageStateForStorage(source.storage, database);
      if (!state || state.resourceRef !== input.resourceRef || !state.currentPublishedRevisionRef) fail('AGENT_WORKFLOW_PACKAGE_UNAVAILABLE', 'Publish the package before assigning an exact version.');
      const selected = await getCapabilityPackagePublishedRevision(input.resourceRef, input.publishedRevisionRef, database);
      if (!selected || selected.checksum !== input.checksum) fail('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected published package changed.'); return selected;
    });
  const location = { ...published, owner: source.descriptor.metadata.ownership,
    rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: source.descriptor.metadata.ownership }) };
  await verifyCapabilityPackageSnapshot(location);
  const validated = await validateCompleteCapabilityPackage(published.kind, location.rootPath, { name: published.name, version: published.version });
  if (validated.checksum !== published.checksum) fail('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected published package changed.');
  const availableSkills = validated.manifest
    ? (await parsePluginSkillsFromManifest(validated.manifest, location.rootPath, path.join(location.rootPath, validated.manifest.skills || 'skills'))).skills
      .map(skill => ({ name: skill.name, relativeRoot: path.relative(location.rootPath, skill.directory).split(path.sep).join('/') }))
    : [{ name: (await parseSkillFile(path.join(location.rootPath, 'SKILL.md')))?.name ?? '', relativeRoot: '' }];
  if (input.skillSelection.kind === 'plugin' && published.kind !== 'plugin') fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'This published package is a standalone skill.');
  const selectedSkills = input.skillSelection.kind === 'plugin' ? availableSkills : input.skillSelection.relativeRoots.map(root => {
    const matches = availableSkills.filter(skill => skill.relativeRoot === root);
    if (matches.length !== 1) fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'Choose an exact skill root from this published package.'); return matches[0];
  });
  if (!selectedSkills.length && input.skillSelection.kind !== 'plugin' || selectedSkills.some(skill => !skill.name)
    || new Set(selectedSkills.map(skill => skill.relativeRoot)).size !== selectedSkills.length
    || input.childRelativeRoot !== undefined && (selectedSkills.length !== 1 || selectedSkills[0].relativeRoot !== input.childRelativeRoot)) fail('AGENT_WORKFLOW_PACKAGE_INVALID', 'The selected skill roots are invalid.');
  const activePaths = new Set(selectedSkills.map(skill => skill.relativeRoot ? `${skill.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml'));
  if (input.skillSelection.kind === 'plugin') activePaths.add('.canvas-plugin/plugin.json');
  const declared = (validated.workflowDeclarations ?? []).filter(declaration => activePaths.has(declaration.declarationPath));
  if (input.declarations.some(declaration => !declared.some(candidate => candidate.declarationPath === declaration.declarationPath))) fail('AGENT_WORKFLOW_DECLARATION_INVALID', 'The declaration is not in the selected package scope.');
  const declarations: StoredAgentWorkflowPackage['declarations'] = [];
  for (const declaration of declared) {
    const supplied = input.declarations.find(candidate => candidate.declarationPath === declaration.declarationPath);
    if (declaration.workflow.integrationCapabilities.some(capability => capability.required && !supplied?.capabilities.some(candidate => candidate.capabilityId === capability.id))) {
      fail('AGENT_WORKFLOW_REQUIRED_BINDING', 'Every required declared capability needs an explicit binding.');
    }
    const capabilities: StoredAgentWorkflowPackage['declarations'][number]['capabilities'] = [];
    for (const selected of supplied?.capabilities ?? []) {
      const capability = declaration.workflow.integrationCapabilities.find(candidate => candidate.id === selected.capabilityId);
      if (!capability || capability.required && selected.required === false) fail('AGENT_WORKFLOW_REQUIRED_BINDING', 'A declared required capability cannot be removed or downgraded.');
      const alternative = (key: string) => {
        const match = capability.alternatives.find(candidate => alternativeKey(candidate) === key);
        if (!match) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'Choose an exact declared alternative.'); return match;
      };
      let selection: StoredAgentWorkflowPackage['declarations'][number]['capabilities'][number]['selection'];
      if (selected.selection.mode === 'fixed') selection = { ...selected.selection,
        target: await prepareTarget(actor, selected.selection.target, alternative(selected.selection.alternativeKey), prepared) };
      else {
        const policy = selected.selection.personalPolicy;
        for (const key of policy?.alternativeKeys ?? []) {
          const choice = alternative(key);
          if (!policy!.sources.includes(choice.source) || choice.source === 'mcp' && !policy!.mcpDefinitionMappings?.some(mapping => mapping.connector === choice.connector)) {
            fail('AGENT_WORKFLOW_MAPPING_REQUIRED', 'Personal MCP choices require an explicit approved definition mapping.');
          }
        }
        selection = { ...selected.selection, allowedChoices: await Promise.all(selected.selection.allowedChoices.map(async choice => ({ ...choice,
          target: await prepareTarget(actor, choice.target, alternative(choice.alternativeKey), prepared) }))) };
      }
      capabilities.push({ capabilityId: capability.id, application: capability.application, alternatives: structuredClone(capability.alternatives),
        required: capability.required || selected.required === true, selection });
    }
    declarations.push({ declarationPath: declaration.declarationPath, capabilities });
  }
  return { storage: source.storage, published, stored: { ...input, version: 1, selectedSkills, declarations } };
}

async function revalidateTargets(prepared: PreparedTargets, database: SqlConnection): Promise<void> {
  if (prepared.personal.length) {
    const { revalidatePreparedPersonalWorkflowProviderTarget } = await import('@/app/lib/integration-tools/workflow-personal-bindings');
    for (const proof of prepared.personal) await revalidatePreparedPersonalWorkflowProviderTarget(proof, { database });
  }
  for (const entry of prepared.mcp) {
    const config = await readMcpConfig(entry.scope);
    const connection = Object.values(config.mcpServers).find(candidate => candidate.connectionId === entry.connectionId);
    const mapping = entry.target.verifiedMcpMapping!;
    if (!connection || hashMcpLegacyConfig(connection) !== mapping.configFingerprint) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected MCP configuration changed.');
    if (mapping.definitionId) {
      const definition = (await listMcpServerDefinitions(entry.scope.shared!.ownership.organizationId)).find(candidate => candidate.id === mapping.definitionId);
      if (!definition?.enabled || definition.revision !== mapping.definitionRevision) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The approved MCP definition changed.');
    }
  }
}
async function withPackages<T>(database: SqlConnection, actor: AgentManagementActor, packages: readonly PreparedPackage[], callback: () => Promise<T>, index = 0): Promise<T> {
  if (index === packages.length) return callback();
  const entry = packages[index];
  return withAuthorizedCapabilityPackageResource({ userId: actor.userId, workspaceId: actor.workspaceId }, entry.storage, 'use', undefined,
    async (_authorization, connection) => {
      const selected = await getCapabilityPackagePublishedRevision(entry.stored.resourceRef, entry.stored.publishedRevisionRef, connection);
      if (!selected || selected.checksum !== entry.stored.checksum) fail('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected published package changed.');
      return withPackages(database, actor, packages, callback, index + 1);
    }, { database });
}
function validateBoundTargets(packages: readonly StoredAgentWorkflowPackage[], bindings: readonly IntegrationConnectionBindingAuthorization[], requireMappingManage = true): void {
  for (const entry of packages) for (const declaration of entry.declarations) for (const capability of declaration.capabilities) {
    const selections = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
    for (const selected of selections) {
      const target = selected.target, alternative = capability.alternatives.find(candidate => alternativeKey(candidate) === selected.alternativeKey)!;
      if (selected.toolCap !== null && (alternative.requiredTools ?? []).some(name => !selected.toolCap!.includes(name))) fail('AGENT_WORKFLOW_TOOLS_DENIED', 'The configured tool limit excludes a required declared tool.');
      if (target.kind !== 'shared') continue;
      const binding = bindings.find(candidate => candidate.resource.connectionRef === target.connectionRef);
      if (!binding || binding.resource.source !== target.source || binding.resource.bindingRevision !== target.bindingRevision) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The selected connection binding changed.');
      if (alternative.source === 'composio' && (binding.backend.source !== 'composio' || binding.backend.toolkit !== alternative.toolkit)) fail('AGENT_WORKFLOW_BINDING_INVALID', 'The selected connection belongs to a different declared toolkit.');
      if (alternative.source === 'mcp' && (!target.verifiedMcpMapping || requireMappingManage && !binding.canManage)) fail('AGENT_WORKFLOW_MAPPING_REQUIRED', 'MCP mapping requires current connection management authority.', 403);
      if (binding.allowedToolNames !== null && (alternative.requiredTools ?? []).some(name => !binding.allowedToolNames!.includes(name))) fail('AGENT_WORKFLOW_TOOLS_DENIED', 'The current connection does not grant a required declared tool.', 403);
    }
  }
}

/** One lease and one commit for profile, native tools, model tuple, version pins and bindings. */
export async function updateManagedAgentConfiguration(input: UpdateManagedAgentConfigurationInput,
  options: { auditAction?: 'agent.update_profile' | 'agent.update_runtime' } = {}): Promise<{ agent: AgentProfile; workflow: AgentWorkflowDescriptor }> {
  const captured = structuredClone(input), changesWorkflow = captured.workflow !== undefined;
  const changesLegacyCapabilities = [captured.capabilities, captured.relevantSkills, captured.relevantConnections].some(value => value !== undefined);
  if (Object.keys(captured).some(key => !['actor', 'agentId', 'expectedRevision', 'expectedWorkflowRevision', 'name', 'iconId', 'enabledTools',
    'defaultProviderInstallationId', 'defaultProvider', 'defaultModel', 'defaultThinking', 'expectedCatalogRevision', 'workflow', 'capabilities', 'relevantSkills', 'relevantConnections'].includes(key))
    || !Number.isSafeInteger(captured.expectedRevision) || captured.expectedRevision < 1) fail('AGENT_WORKFLOW_INVALID', 'The configuration request contains unsupported fields or revisions.', 400);
  const preflight = await openDb();
  let actor: AgentManagementActor, before: AgentWorkflowInternalSnapshot;
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(captured.actor, preflight);
    actor = { ...captured.actor, organizationId: verified.context.organizationId, workspaceId: verified.context.workspaceId, projectId: verified.context.projectId };
    before = await readManagedAgentWorkflowOnConnection(preflight, captured.agentId);
    if (changesWorkflow && changesLegacyCapabilities) fail('AGENT_WORKFLOW_INVALID', 'Use either explicit workflow bindings or legacy capability fields in one update.', 400);
    if (before.workflowVersion !== null && changesLegacyCapabilities) fail('AGENT_WORKFLOW_UPDATE_REQUIRED', 'Update the explicit workflow configuration to change its package bindings.');
    if (before.agent.type === 'main') fail('AGENT_MAIN_PROTECTED', 'The built-in main agent is configured through organization policy.', 403);
    if (!(await getAgentAccessOnConnection(preflight, actor.userId, before.agent.agentId, verified.context)).canEdit) fail('AGENT_ACCESS_DENIED', 'Agent access denied.', 403);
    if (before.agent.revision !== captured.expectedRevision) throw new AgentRevisionConflictError(before.agent.revision);
    if (changesWorkflow && revision(captured.expectedWorkflowRevision) !== before.workflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The workflow configuration changed.');
  } finally { await preflight.close(); }
  const relevantSkills = captured.relevantSkills === undefined ? before!.agent.relevantSkills : captured.relevantSkills;
  const relevantConnections = captured.relevantConnections === undefined ? before!.agent.relevantConnections : captured.relevantConnections;
  const legacyCapabilities = changesLegacyCapabilities ? await resolveCapabilityBindings({ actor: actor!, scopeType: before!.agent.scopeType === 'organization' ? 'organization' : 'user',
    capabilities: captured.capabilities === undefined ? before!.bindings.filter(binding => binding.resourceType === 'plugin').map(binding => ({ resourceType: 'plugin', resourceId: binding.resourceId, name: binding.name, requirement: binding.requirement })) : captured.capabilities,
    relevantSkills, relevantConnections }) : null;
  const prepared: PreparedTargets = { personal: [], mcp: [] };
  const configuration = changesWorkflow && captured.workflow !== null ? parseAgentWorkflowConfiguration(captured.workflow) : null;
  const packages: PreparedPackage[] = [];
  for (const entry of configuration?.packages ?? []) {
    const selected = await preparePackage(actor!, entry, prepared);
    if (before!.agent.scopeType === 'organization' && selected.storage.scopeType === 'user') fail('AGENT_ORGANIZATION_CAPABILITY_SCOPE_INVALID', 'Organization agents cannot embed personal packages.', 403);
    if (before!.agent.scopeType === 'organization' && targets(selected.stored).some(target => target.kind === 'personal')) fail('AGENT_WORKFLOW_BINDING_DENIED', 'Use shared fixed bindings or an explicit per-user personal choice policy for an organization agent.', 403);
    packages.push(selected);
  }
  packages.sort((left, right) => left.storage.resourceId.localeCompare(right.storage.resourceId));
  await validateSpecialAgentTools(captured.enabledTools);
  await assertBrowserToolCanBeEnabled({ previousEnabledTools: before!.agent.enabledTools, nextEnabledTools: captured.enabledTools === undefined ? before!.agent.enabledTools : captured.enabledTools });
  const changesDefault = [captured.defaultProviderInstallationId, captured.defaultProvider, captured.defaultModel, captured.defaultThinking].some(value => value !== undefined);
  const model = changesDefault ? parseAgentDefaultFields({ providerInstallationId: captured.defaultProviderInstallationId === undefined ? before!.agent.defaultProviderInstallationId : captured.defaultProviderInstallationId,
    providerId: captured.defaultProvider === undefined ? before!.agent.defaultProvider : captured.defaultProvider,
    modelId: captured.defaultModel === undefined ? before!.agent.defaultModel : captured.defaultModel,
    thinkingLevel: captured.defaultThinking === undefined ? before!.agent.defaultThinking : captured.defaultThinking }) : null;
  const database = await openDb(); let agent: AgentProfile;
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor!, database, { lock: true });
    if (captured.enabledTools !== undefined && before!.agent.agentId === EMAIL_MANAGED_AGENT_ID && !['owner', 'admin'].includes(verified.organizationRole ?? '')) {
      fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required to configure the email agent.', 403);
    }
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: actor!.userId, ...verified.context }, references(packages));
    await revalidateTargets(prepared, database);
    agent = await withPackages(database, actor!, packages, async () => {
      if (changesDefault) {
        if (!verified.organizationId || !['owner', 'admin'].includes(verified.organizationRole ?? '') || before!.agent.organizationId && before!.agent.organizationId !== verified.organizationId) fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required for model defaults.', 403);
        await validateAgentDefaultOnConnection(database, { organizationId: verified.organizationId, selection: model,
          expectedCatalogRevision: model ? parseAgentDefaultCatalogRevision(captured.expectedCatalogRevision, true) : undefined });
      }
      const current = await readAgentProfileOnConnection(database, before!.agent.agentId, true);
      if (!current) fail('AGENT_NOT_FOUND', 'Agent not found.', 404);
      await holdAgentGrantAuthority(database, actor!, current);
      const currentAccess = await getAgentAccessOnConnection(database, actor!.userId, current.agentId, verified.context);
      if (!currentAccess.canEdit) fail('AGENT_ACCESS_DENIED', 'Agent access denied.', 403);
      if (current.revision !== captured.expectedRevision) throw new AgentRevisionConflictError(current.revision);
      const header = await readManagedAgentWorkflowOnConnection(database, current.agentId);
      if (changesWorkflow && header.workflowRevision !== captured.expectedWorkflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The workflow configuration changed.');
      validateBoundTargets(packages.map(entry => entry.stored), await authorizeIntegrationConnectionBindingsOnConnection(database, batch, current, 'configure'));
      await revalidateTargets(prepared, database);
      const next = await updateAgentProfile({ agentId: current.agentId, expectedRevision: captured.expectedRevision,
        name: captured.name, iconId: captured.iconId === undefined ? undefined : normalizeAgentIconId(captured.iconId), enabledTools: captured.enabledTools,
        ...(changesDefault ? { defaultProviderInstallationId: model?.providerInstallationId ?? null, defaultProvider: model?.providerId ?? null,
          defaultModel: model?.modelId ?? null, defaultThinking: model?.thinkingLevel ?? null } : {}),
        ...(legacyCapabilities ? { relevantSkills, relevantConnections } : {}),
        ...(changesWorkflow ? { expectedWorkflowRevision: header.workflowRevision, workflowVersion: configuration ? 1 : null, workflowRevision: header.workflowRevision + 1,
          relevantSkills: configuration ? packages.flatMap(entry => entry.stored.selectedSkills.map(skill => skill.name)) : current.relevantSkills } : {}) }, database);
      if (changesWorkflow) {
        const inputs: AgentCapabilityBindingInput[] = configuration ? packages.map(entry => ({ ...entry.storage, version: entry.published.version,
          requirement: entry.stored.declarations.some(declaration => declaration.capabilities.some(capability => capability.required)) ? 'required' : 'optional', configuration: entry.stored }))
          : header.bindings.map(({ configuration: _configuration, id: _id, agentId: _agentId, revision: _revision, ...binding }) => ({ ...binding, configuration: null }));
        await replaceAgentCapabilityBindings(current.agentId, inputs, database, { workflowMutation: true });
      } else if (legacyCapabilities) await replaceAgentCapabilityBindings(current.agentId, legacyCapabilities.bindings, database);
      return next;
    });
    await database.run('COMMIT');
  } catch (error) { try { await database.run('ROLLBACK'); } catch { /* Preserve the authoritative failure. */ } throw error; }
  finally { await database.close(); }
  await auditAgentAction({ actor: actor!, agentId: agent!.agentId, profile: agent!, action: options.auditAction ?? 'agent.update_configuration',
    input: { workflowChanged: changesWorkflow }, output: { revision: agent!.revision, workflowRevision: agent!.workflowRevision } });
  return { agent: agent!, workflow: await inspectManagedAgentWorkflow(actor!, agent!.agentId) };
}

function connectionOptionKey(target: StoredAgentWorkflowTarget): string {
  return target.kind === 'shared' ? JSON.stringify([target.kind, target.connectionRef, target.bindingRevision])
    : JSON.stringify([target.kind, target.boundProviderRef, target.bindingFingerprint]);
}
async function readWorkflowConnectionOptions(actor: AgentManagementActor, snapshot: AgentWorkflowInternalSnapshot): Promise<Map<string, AgentWorkflowConnectionOption>> {
  const selectedTargets = snapshot.bindings.flatMap(binding => binding.configuration ? targets(binding.configuration) : []);
  selectedTargets.push(...Object.values(snapshot.choices).flatMap(choice => choice.personalTarget ? [choice.personalTarget] : []));
  const unique = new Map(selectedTargets.map(target => [connectionOptionKey(target), target]));
  const options = new Map<string, AgentWorkflowConnectionOption>();
  for (const [key, target] of unique) {
    const unavailable: AgentWorkflowConnectionOption = { label: 'Unavailable connection', availability: 'unavailable', status: 'unavailable' };
    if (target.kind === 'personal') {
      if (target.ownerUserId !== actor.userId) { options.set(key, unavailable); continue; }
      const helpers = await import('@/app/lib/integration-tools/workflow-personal-bindings');
      try {
        await helpers.verifyStoredPersonalWorkflowProviderTarget({ actor, target: { binding: target.personalBinding!, boundProviderRef: target.boundProviderRef!,
          baseProviderRef: target.providerRef, bindingFingerprint: target.bindingFingerprint! } }, { checkProviderReadiness: false });
        options.set(key, { label: target.source === 'mcp' ? 'Personal MCP connection' : 'Personal Composio connection', availability: 'available',
          status: 'unknown', source: target.source, scopeLabel: 'personal' });
      } catch { options.set(key, unavailable); }
      continue;
    }
    const database = await openDb();
    try {
      await database.run('BEGIN');
      const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database, { lock: true });
      const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: actor.userId, ...verified.context }, [target.connectionRef]);
      await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [snapshot.agent.agentId]);
      const current = await readManagedAgentWorkflowOnConnection(database, snapshot.agent.agentId);
      await holdAgentGrantAuthority(database, actor, current.agent);
      if (current.agent.revision !== snapshot.agent.revision || current.workflowRevision !== snapshot.workflowRevision) {
        fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The workflow configuration changed.');
      }
      const [authorized] = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, current.agent, 'read');
      if (authorized.resource.bindingRevision !== target.bindingRevision || authorized.resource.source !== target.source) options.set(key, unavailable);
      else {
        const setup = authorized.backend.source === 'composio' && authorized.backend.accountBinding === 'pending';
        options.set(key, { label: authorized.resource.displayName, availability: setup ? 'unavailable' : 'available', status: setup ? 'setup_required' : 'unknown',
          source: target.source, scopeLabel: authorized.resource.ownership.type === 'team' ? 'team' : 'organization', connectionRef: target.connectionRef });
      }
      await database.run('COMMIT');
    } catch (error) {
      try { await database.run('ROLLBACK'); } catch { /* Preserve the authoritative failure. */ }
      if (!isIntegrationConnectionError(error) || !['CONNECTION_ACCESS_DENIED', 'CONNECTION_NOT_FOUND'].includes(error.code)) throw error;
      options.set(key, unavailable);
    } finally { await database.close(); }
  }
  return options;
}

export async function inspectManagedAgentWorkflow(actor: AgentManagementActor, agentId: string): Promise<AgentWorkflowDescriptor> {
  const snapshot = await readManagedAgentWorkflow(actor, agentId), access = snapshot.access;
  const connectionOptions = await readWorkflowConnectionOptions(actor, snapshot);
  const packages: AgentWorkflowDescriptor['packages'] = [];
  let unavailablePackageCount = 0;
  for (const binding of snapshot.bindings) {
    const configuration = binding.configuration;
    if (!configuration) continue;
    const resource = await findCapabilityResourceRecord(configuration.resourceRef);
    const currentAccess = resource ? (await getCapabilityResourceAccess({ userId: actor.userId, workspaceId: actor.workspaceId }, resource.storage)).access : null;
    if (!currentAccess?.canUse) unavailablePackageCount++;
    if (!currentAccess?.canRead) continue;
    packages.push({ resourceRef: configuration.resourceRef, publishedRevisionRef: configuration.publishedRevisionRef, checksum: configuration.checksum, name: binding.name,
      declarations: configuration.declarations.map(declaration => ({ declarationPath: declaration.declarationPath, capabilities: declaration.capabilities.map(capability => {
        const key = agentWorkflowCapabilityKey(configuration.resourceRef, declaration.declarationPath, capability.capabilityId);
        const recorded = snapshot.choices[key];
        const selected = recorded?.workflowRevision === snapshot.workflowRevision ? recorded : undefined;
        const selection = capability.selection;
        const choices = selection.mode === 'selectable' ? selection.allowedChoices : [];
        const resolved = getSelectedAgentWorkflowCapability(snapshot, configuration, declaration, capability);
        return { capabilityKey: key, capabilityId: capability.capabilityId, application: capability.application, required: capability.required, selectionMode: capability.selection.mode,
          choices: choices.map(choice => ({ choiceId: choice.choiceId, kind: choice.target.kind, ...connectionOptions.get(connectionOptionKey(choice.target))! })),
          ...(resolved ? { selectedConnection: connectionOptions.get(connectionOptionKey(resolved.target)) } : {}),
          selectionOrigin: selection.mode === 'fixed' ? 'fixed' : !recorded ? 'default' : selected && resolved ? 'user' : 'stale',
          selectedKind: resolved?.target.kind ?? null,
          selectedChoiceId: selected?.choiceId && choices.some(choice => choice.choiceId === selected.choiceId) ? selected.choiceId
            : !recorded && selection.mode === 'selectable' ? selection.defaultChoiceId ?? null : null,
          personalChoiceAllowed: capability.selection.mode === 'selectable' && Boolean(capability.selection.personalPolicy) };
      }) })) });
  }
  return { agentId: snapshot.agent.agentId, revision: snapshot.agent.revision, workflowVersion: snapshot.workflowVersion, workflowRevision: snapshot.workflowRevision,
    preferenceRevision: snapshot.preferenceRevision, unavailablePackageCount, access, packages };
}
export async function listManagedAgentWorkflowOptions(actor: AgentManagementActor, agentId: string): Promise<AgentWorkflowDescriptor> {
  return inspectManagedAgentWorkflow(actor, agentId);
}

function capabilitySlot(snapshot: AgentWorkflowInternalSnapshot, key: string) {
  for (const binding of snapshot.bindings) if (binding.configuration) for (const declaration of binding.configuration.declarations) {
    for (const capability of declaration.capabilities) if (agentWorkflowCapabilityKey(binding.configuration.resourceRef, declaration.declarationPath, capability.capabilityId) === key) {
      return { pkg: binding.configuration, declaration, capability };
    }
  }
  return fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose a capability from the current workflow configuration.');
}
export async function setManagedAgentWorkflowChoice(input: { actor: AgentManagementActor; agentId: string; capabilityKey: string;
  expectedWorkflowRevision: number; expectedPreferenceRevision: number; choiceId?: string | null;
  personalSelection?: { alternativeKey: string; target: AgentWorkflowTarget } }): Promise<AgentWorkflowDescriptor> {
  const captured = structuredClone(input);
  if (Object.keys(captured).some(key => !['actor', 'agentId', 'capabilityKey', 'expectedWorkflowRevision', 'expectedPreferenceRevision', 'choiceId', 'personalSelection'].includes(key))
    || (captured.choiceId === undefined) === (captured.personalSelection === undefined)) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'Choose one permitted selection or explicitly clear it.', 400);
  const expectedPreferenceRevision = revision(captured.expectedPreferenceRevision), expectedWorkflowRevision = revision(captured.expectedWorkflowRevision);
  const snapshot = await readManagedAgentWorkflow(captured.actor, captured.agentId);
  if (!snapshot.access.canUse || snapshot.workflowVersion !== 1) fail('AGENT_ACCESS_DENIED', 'Current agent use is required to save your own selection.', 403);
  if (snapshot.workflowRevision !== expectedWorkflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The workflow configuration changed.');
  const slot = capabilitySlot(snapshot, captured.capabilityKey);
  if (slot.capability.selection.mode !== 'selectable') fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This capability has a fixed central binding.', 403);
  const prepared: PreparedTargets = { personal: [], mcp: [] };
  let choice: AgentWorkflowChoice | null = null;
  let selected: { alternativeKey: string; target: StoredAgentWorkflowTarget; toolCap: string[] | null } | null = null;
  if (captured.personalSelection !== undefined) {
    if (Object.keys(captured.personalSelection).some(key => !['alternativeKey', 'target'].includes(key))) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'The personal selection is invalid.', 400);
    const policy = slot.capability.selection.personalPolicy, parsed = agentWorkflowTargetSchema.safeParse(captured.personalSelection.target);
    if (!policy || !parsed.success || parsed.data.kind !== 'personal' || !policy.sources.includes(parsed.data.source)
      || !policy.alternativeKeys.includes(captured.personalSelection.alternativeKey)) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This personal source is not allowed by the central configuration.', 403);
    const alternative = slot.capability.alternatives.find(candidate => alternativeKey(candidate) === captured.personalSelection!.alternativeKey);
    if (!alternative) fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'The declared alternative is unavailable.');
    const target = await prepareTarget(captured.actor, parsed.data, alternative, prepared);
    if (alternative.source === 'mcp' && (target.personalBinding?.source !== 'mcp' || !target.personalBinding.serverDefinitionId
      || !policy.mcpDefinitionMappings?.find(mapping => mapping.connector === alternative.connector)?.serverDefinitionIds.includes(target.personalBinding.serverDefinitionId))) {
      fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose your own connection from an explicitly approved MCP definition.', 403);
    }
    choice = { workflowRevision: expectedWorkflowRevision, personalTarget: target, alternativeKey: captured.personalSelection.alternativeKey };
    selected = { alternativeKey: captured.personalSelection.alternativeKey, target, toolCap: policy.toolCap };
  } else if (captured.choiceId !== null && captured.choiceId !== undefined) {
    const allowed = slot.capability.selection.allowedChoices.find(candidate => candidate.choiceId === captured.choiceId);
    if (!allowed) fail('AGENT_WORKFLOW_CHOICE_DENIED', 'Choose a connection from the central allowlist.', 403);
    choice = { workflowRevision: expectedWorkflowRevision, choiceId: allowed.choiceId }; selected = allowed;
  }
  const refs = selected?.target.kind === 'shared' ? [selected.target.connectionRef] : [];
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(captured.actor, database, { lock: true });
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: captured.actor.userId, ...verified.context }, refs);
    await revalidateTargets(prepared, database);
    await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [snapshot.agent.agentId]);
    const current = await readManagedAgentWorkflowOnConnection(database, snapshot.agent.agentId);
    await holdAgentGrantAuthority(database, captured.actor, current.agent);
    if (current.workflowVersion !== 1 || current.workflowRevision !== expectedWorkflowRevision) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The workflow configuration changed.');
    if (!(await getAgentAccessOnConnection(database, captured.actor.userId, current.agent.agentId, verified.context)).canUse) fail('AGENT_ACCESS_DENIED', 'Agent use was revoked.', 403);
    const currentSlot = capabilitySlot(current, captured.capabilityKey);
    if (currentSlot.capability.selection.mode !== 'selectable') fail('AGENT_WORKFLOW_CHOICE_DENIED', 'This capability is centrally fixed.', 403);
    const authorities = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, current.agent, 'read');
    if (selected) {
      const selectedConfiguration = { ...currentSlot.pkg, declarations: [{ declarationPath: currentSlot.declaration.declarationPath,
        capabilities: [{ ...currentSlot.capability, selection: { mode: 'fixed' as const, ...selected } }] }] };
      validateBoundTargets([selectedConfiguration], authorities, false);
    }
    const previousRow = await database.get('SELECT preferences_json,revision FROM agent_user_preferences WHERE agent_id=$1 AND user_id=$2 FOR UPDATE',
      [current.agent.agentId, captured.actor.userId]) as Record<string, unknown> | undefined;
    const preferences = preferenceSnapshot(previousRow);
    if (preferences.revision !== expectedPreferenceRevision) fail('AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT', 'Your saved selection changed. Reload it before saving.');
    const choices = { ...preferences.choices };
    if (choice) choices[captured.capabilityKey] = choice; else delete choices[captured.capabilityKey];
    const encoded = JSON.stringify({ ...preferences.json, workflowChoices: choices });
    if (Buffer.byteLength(encoded) > 1_048_576) fail('AGENT_WORKFLOW_CHOICE_INVALID', 'The stored choices exceed their limit.', 400);
    await revalidateTargets(prepared, database);
    const now = Date.now();
    const written = previousRow ? await database.get(`UPDATE agent_user_preferences SET preferences_json=$1,revision=revision+1,updated_at=$2
      WHERE agent_id=$3 AND user_id=$4 AND revision=$5 AND preferences_json=$6 RETURNING revision`,
    [encoded, now, current.agent.agentId, captured.actor.userId, expectedPreferenceRevision, previousRow.preferences_json])
      : await database.get(`INSERT INTO agent_user_preferences(agent_id,user_id,preferences_json,revision,created_at,updated_at) VALUES($1,$2,$3,1,$4,$4)
        ON CONFLICT(agent_id,user_id) DO NOTHING RETURNING revision`, [current.agent.agentId, captured.actor.userId, encoded, now]);
    if (!written) fail('AGENT_WORKFLOW_CHOICE_REVISION_CONFLICT', 'Your saved selection changed. Reload it before saving.');
    await database.run('COMMIT');
  } catch (error) { try { await database.run('ROLLBACK'); } catch { /* Preserve the authority/CAS failure. */ } throw error; }
  finally { await database.close(); }
  await auditAgentAction({ actor: captured.actor, agentId: snapshot.agent.agentId, action: 'agent.update_workflow_choice', input: { capabilityKey: captured.capabilityKey }, output: { workflowRevision: expectedWorkflowRevision } });
  return inspectManagedAgentWorkflow(captured.actor, snapshot.agent.agentId);
}
