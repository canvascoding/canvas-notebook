import 'server-only';

import { hashAuditValue, recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  AgentDefaultPolicyError,
  parseAgentDefaultCatalogRevision,
  parseAgentDefaultFields,
  writeAgentDefaultWithCatalogValidation,
} from '@/app/lib/agent-runtime-policy/agent-default-service';
import { AiRuntimeInputError } from '@/app/lib/agent-runtime-policy/runtime-service';
import { isAgentWorkflowError } from './workflow-contracts';
import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { INTEGRATION_GATEWAY_ERROR_MESSAGES, readIntegrationContractErrorCode } from '@/app/lib/integration-tools/agent-errors';
import {
  createAgentManagerMembership,
  getAgentAccess,
  getAgentAccessOnConnection,
  listAgentAccessForUser,
  requireAgentAccess,
  type AgentAccess,
  type AgentAccessContext,
} from '@/app/lib/agents/access';
import {
  listAgentCapabilityBindings,
  replaceAgentCapabilityBindings,
  type AgentCapabilityBinding,
  type AgentCapabilityBindingInput,
} from '@/app/lib/agents/capability-bindings';
import {
  createAgentDeleteConfirmationToken,
  verifyAgentDeleteConfirmationToken,
} from '@/app/lib/agents/confirmation-tokens';
import {
  listAgentGrants,
  removeAgentGrant,
  upsertAgentGrant,
  type AgentGrantTargetType,
} from '@/app/lib/agents/grants';
import { normalizeAgentIconId, type AgentIconId } from '@/app/lib/agents/icons';
import {
  AgentRevisionConflictError,
  createAgentProfile,
  deleteAgentProfile,
  getAgentProfile,
  listAgentProfiles,
  normalizeManagedAgentId,
  updateAgentProfile,
  readAgentProfileOnConnection,
  type AgentProfile,
} from '@/app/lib/agents/registry';
import {
  AGENT_MANAGED_FILE_NAMES,
  DEFAULT_MANAGED_AGENT_ID,
  deleteManagedAgentDefinitionStorage,
  isManagedAgentFileName,
  isWritableManagedAgentFileName,
  readManagedAgentFile,
  readManagedAgentFiles,
  resetManagedAgentFile,
  writeManagedAgentFile,
  type AgentManagedFileName,
  type AgentStorageScope,
} from '@/app/lib/agents/storage';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import type { EffectiveCapabilitySnapshot } from '@/app/lib/capabilities/types';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { isAgentActorContextError, resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { isOrganizationAdminLike, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { assertBrowserToolCanBeEnabled } from '@/app/lib/pi/browser/settings-service';

export type AgentManagementSource = 'api' | 'tool' | 'ui' | 'system';

export type AgentManagementActor = {
  userId: string;
  sessionId?: string | null;
  source?: AgentManagementSource;
  sourceAgentId?: string | null;
  organizationId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
};

export type AgentCapabilitySelection = {
  resourceType: 'skill' | 'plugin';
  resourceId?: string;
  name?: string;
  requirement?: 'optional' | 'required';
};

export type CreateManagedAgentInput = {
  name: string;
  agentId?: string | null;
  iconId?: AgentIconId | string | null;
  scopeType?: 'user' | 'organization';
  defaultProviderInstallationId?: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinking?: unknown;
  expectedCatalogRevision?: unknown;
  enabledTools?: string[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
  capabilities?: AgentCapabilitySelection[] | null;
  files?: Partial<Record<AgentManagedFileName, string>> | null;
  grants?: Array<{
    targetType: AgentGrantTargetType;
    targetId: string;
    canUse?: boolean;
    canEdit?: boolean;
    canManage?: boolean;
  }> | null;
};

export type AgentReadinessEntry = {
  resourceType: 'skill' | 'plugin' | 'connection';
  resourceId: string;
  name: string;
  readiness: 'available' | 'disabled' | 'blocked' | 'conflict' | 'personal-connection-required' | 'missing';
  reason: string | null;
};

export class AgentManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentManagementError';
  }
}

function source(actor: AgentManagementActor): AgentManagementSource {
  return actor.source || 'api';
}

function accessContext(actor: AgentManagementActor): AgentAccessContext {
  return {
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    projectId: actor.projectId,
  };
}

async function actorOrganization(actor: AgentManagementActor) {
  const state = await readOrganizationPermissionForUser(actor.userId);
  const organizationId = actor.organizationId || state.organizationId;
  if (actor.organizationId && state.organizationId && actor.organizationId !== state.organizationId) {
    throw new AgentManagementError('AGENT_ORGANIZATION_MISMATCH', 'The requested organization is not available to this user.', 403);
  }
  return { state, organizationId: organizationId || null };
}

async function requireOrganizationAdmin(actor: AgentManagementActor): Promise<string> {
  const { state, organizationId } = await actorOrganization(actor);
  if (!organizationId || !isOrganizationAdminLike(state.permission)) {
    throw new AgentManagementError(
      'AGENT_ORGANIZATION_ADMIN_REQUIRED',
      'Organization owner or admin permission is required.',
      403,
    );
  }
  return organizationId;
}

function storageScope(profile: AgentProfile, actor: AgentManagementActor): AgentStorageScope {
  return {
    userId: actor.userId,
    organizationId: profile.organizationId || actor.organizationId,
    workspaceId: actor.workspaceId,
    projectId: actor.projectId,
    agentScopeType: profile.scopeType,
    ownerUserId: profile.ownerUserId,
  };
}

function ensureExpectedRevision(profile: AgentProfile, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new AgentManagementError('AGENT_REVISION_REQUIRED', 'expectedRevision must be a positive integer.');
  }
  if (profile.revision !== expectedRevision) throw new AgentRevisionConflictError(profile.revision);
}

async function requireProfile(
  actor: AgentManagementActor,
  agentIdInput: string,
  permission: keyof AgentAccess,
): Promise<AgentProfile> {
  actor = await verifiedManagementActor(actor);
  const agentId = normalizeManagedAgentId(agentIdInput);
  const profile = await getAgentProfile(agentId);
  if (!profile) throw new AgentManagementError('AGENT_NOT_FOUND', 'Agent not found.', 404);
  await requireAgentAccess(actor.userId, agentId, permission, accessContext(actor));
  return profile;
}

async function verifiedManagementActor(actor: AgentManagementActor, database?: SqlConnection): Promise<AgentManagementActor> {
  const captured = structuredClone(actor);
  const connection = database ?? await openDb();
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(captured, connection, { lock: Boolean(database) });
    const rest = { ...captured };
    delete rest.organizationId;
    delete rest.workspaceId;
    delete rest.projectId;
    return { ...rest, userId: verified.userId, ...verified.context };
  } finally {
    if (!database) await connection.close();
  }
}

/** Profile CAS and dependent SQL mutations commit together under current actor and agent authority. */
async function withAgentManagementWrite<T>(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  permission: 'canEdit' | 'canManage';
}, operation: (profile: AgentProfile, actor: AgentManagementActor, database: SqlConnection) => Promise<T>): Promise<T> {
  const captured = structuredClone(input);
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const actor = await verifiedManagementActor(captured.actor, database);
    const profile = await readAgentProfileOnConnection(database, captured.agentId, true);
    if (!profile) throw new AgentManagementError('AGENT_NOT_FOUND', 'Agent not found.', 404);
    const grants = await database.all('SELECT id, target_type, target_id FROM agent_grants WHERE agent_id = $1 ORDER BY id FOR SHARE',
      [profile.agentId]) as Array<{ target_type: string; target_id: string }>;
    await database.all('SELECT user_id FROM agent_members WHERE agent_id = $1 ORDER BY user_id FOR SHARE', [profile.agentId]);
    if (!actor.workspaceId && profile.organizationId) {
      // Global management can be granted through any reachable scope. Hold the
      // actual matching scope authority as well as the agent/grant rows.
      const targets = grants.filter((grant) => grant.target_type === 'workspace' || grant.target_type === 'project')
        .sort((left, right) => `${left.target_type}:${left.target_id}`.localeCompare(`${right.target_type}:${right.target_id}`));
      for (const target of targets) {
        try {
          await resolveVerifiedAgentActorContextOnConnection({ userId: actor.userId, organizationId: profile.organizationId,
            ...(target.target_type === 'workspace' ? { workspaceId: target.target_id } : { projectId: target.target_id }) }, database, { lock: true });
        } catch (error) {
          if (!isAgentActorContextError(error)) throw error;
        }
      }
    }
    const access = await getAgentAccessOnConnection(database, actor.userId, profile.agentId, accessContext(actor));
    if (!access[captured.permission]) throw new AgentManagementError('AGENT_ACCESS_DENIED', 'Agent access denied.', 403);
    ensureExpectedRevision(profile, captured.expectedRevision);
    const result = await operation(profile, actor, database);
    await database.run('COMMIT');
    return result;
  } catch (error) {
    try { await database.run('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    await database.close();
  }
}

export async function auditAgentAction(input: {
  actor: AgentManagementActor;
  profile?: AgentProfile | null;
  agentId: string;
  action: string;
  status?: 'success' | 'failure' | 'blocked';
  metadata?: unknown;
  input?: unknown;
  output?: unknown;
}): Promise<void> {
  await recordAuditEvent({
    organizationId: input.profile?.organizationId || input.actor.organizationId,
    workspaceId: input.actor.workspaceId,
    projectId: input.actor.projectId,
    userId: input.actor.userId,
    sessionId: input.actor.sessionId,
    agentId: input.actor.sourceAgentId || input.agentId,
    source: `agent-management:${source(input.actor)}`,
    eventType: 'agent',
    entityType: 'agent_profile',
    entityId: input.agentId,
    action: input.action,
    status: input.status || 'success',
    summary: `${input.action} for ${input.agentId}.`,
    metadata: input.metadata,
    inputHash: input.input === undefined ? null : hashAuditValue(input.input),
    outputHash: input.output === undefined ? null : hashAuditValue(input.output),
  });
}

async function capabilitySnapshotForActor(actor: AgentManagementActor): Promise<EffectiveCapabilitySnapshot | null> {
  const { state, organizationId } = await actorOrganization(actor);
  if (!organizationId) return null;
  return resolveEffectiveCapabilitySnapshot({
    organizationId,
    userId: actor.userId,
    role: state.permission?.role,
    workspaceId: actor.workspaceId,
    projectId: actor.projectId,
  });
}

export async function resolveCapabilityBindings(input: {
  actor: AgentManagementActor;
  scopeType: 'user' | 'organization';
  capabilities?: AgentCapabilitySelection[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
}): Promise<{ bindings: AgentCapabilityBindingInput[]; snapshot: EffectiveCapabilitySnapshot | null }> {
  const snapshot = await capabilitySnapshotForActor(input.actor);
  const selections: AgentCapabilitySelection[] = [
    ...(input.capabilities || []),
    ...(input.relevantSkills || []).map((name) => ({ resourceType: 'skill' as const, name })),
  ];
  const bindings: AgentCapabilityBindingInput[] = [];
  const seen = new Set<string>();

  for (const selection of selections) {
    const selected = snapshot?.capabilities.find((candidate) => (
      candidate.ref.resourceType === selection.resourceType
      && (selection.resourceId ? candidate.ref.resourceId === selection.resourceId : candidate.ref.name === selection.name)
    ));
    if (!selected) {
      throw new AgentManagementError(
        'AGENT_CAPABILITY_NOT_FOUND',
        `Capability ${selection.resourceId || selection.name || 'unknown'} is not available.`,
        409,
      );
    }
    if (!selected.effectiveEnabled || selected.readiness === 'blocked' || selected.readiness === 'conflict') {
      throw new AgentManagementError(
        'AGENT_CAPABILITY_UNAVAILABLE',
        selected.blockedReason || `Capability ${selected.ref.name} is unavailable.`,
        409,
        { resourceId: selected.ref.resourceId, readiness: selected.readiness },
      );
    }
    if (input.scopeType === 'organization' && selected.ref.scopeType === 'user') {
      throw new AgentManagementError(
        'AGENT_ORGANIZATION_CAPABILITY_SCOPE_INVALID',
        `Organization agents cannot embed the personal ${selected.ref.resourceType} ${selected.ref.name}.`,
        409,
      );
    }
    const key = `${selected.ref.resourceType}:${selected.ref.scopeType}:${selected.ref.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ ...selected.ref, requirement: selection.requirement });
    if (selected.ref.resourceType === 'plugin') {
      const pluginSkills = snapshot?.capabilities.filter((candidate) => (
        candidate.ref.resourceType === 'skill'
        && candidate.pluginResourceId === selected.ref.resourceId
        && candidate.effectiveEnabled
        && candidate.readiness === 'available'
        && (input.scopeType !== 'organization' || candidate.ref.scopeType !== 'user')
      )) || [];
      for (const pluginSkill of pluginSkills) {
        const skillKey = `${pluginSkill.ref.resourceType}:${pluginSkill.ref.scopeType}:${pluginSkill.ref.resourceId}`;
        if (seen.has(skillKey)) continue;
        seen.add(skillKey);
        bindings.push({ ...pluginSkill.ref, requirement: selection.requirement });
      }
    }
  }

  for (const rawName of input.relevantConnections || []) {
    const name = rawName.trim();
    if (!name) continue;
    const resourceId = `connection:${name.toLowerCase()}`;
    const key = `connection:user:${resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({
      resourceType: 'connection',
      scopeType: 'user',
      resourceId,
      name,
      version: 'runtime',
      requirement: 'optional',
    });
  }
  return { bindings, snapshot };
}

export async function validateSpecialAgentTools(enabledTools: string[] | null | undefined): Promise<void> {
  if (!enabledTools) return;
  const protectedAgentTools = new Set([
    'agent_manage',
    'list_agents',
    'inspect_agent',
    'create_agent',
    'update_agent_profile',
    'update_agent_runtime',
    'update_agent_capabilities',
    'update_agent_configuration',
    'inspect_agent_workflow',
    'list_agent_workflow_options',
    'list_agent_workflow_personal_options',
    'set_agent_workflow_choice',
    'update_agent_file',
    'set_agent_grant',
    'remove_agent_grant',
    'preview_agent_deletion',
    'delete_agent',
  ]);
  const { getPiToolMetadata } = await import('@/app/lib/pi/tool-registry');
  const known = new Set((await getPiToolMetadata()).map((tool) => tool.name));
  known.add('__none__');
  const unknown = enabledTools.filter((toolName) => !known.has(toolName));
  if (unknown.length > 0) {
    throw new AgentManagementError('AGENT_TOOL_UNKNOWN', `Unknown agent tools: ${unknown.join(', ')}`);
  }
  const protectedSelections = enabledTools.filter((toolName) => protectedAgentTools.has(toolName));
  if (protectedSelections.length > 0) {
    throw new AgentManagementError(
      'AGENT_RECURSIVE_MANAGEMENT_BLOCKED',
      'Specialized agents cannot receive agent-management tools.',
      403,
      { protectedSelections },
    );
  }
}

function readinessForBindings(
  bindings: AgentCapabilityBinding[],
  snapshot: EffectiveCapabilitySnapshot | null,
): AgentReadinessEntry[] {
  return bindings.map((binding) => {
    if (binding.resourceType === 'connection') {
      return {
        resourceType: binding.resourceType,
        resourceId: binding.resourceId,
        name: binding.name,
        readiness: 'personal-connection-required' as const,
        reason: 'Each employee must connect this integration in their own user scope before execution.',
      };
    }
    const effective = snapshot?.capabilities.find((candidate) => candidate.ref.resourceId === binding.resourceId);
    if (!effective) {
      return {
        resourceType: binding.resourceType,
        resourceId: binding.resourceId,
        name: binding.name,
        readiness: 'missing' as const,
        reason: 'The referenced capability is no longer installed in the effective organization/user cascade.',
      };
    }
    return {
      resourceType: binding.resourceType,
      resourceId: binding.resourceId,
      name: binding.name,
      readiness: effective.readiness,
      reason: effective.blockedReason,
    };
  });
}

function normalizedFiles(value: CreateManagedAgentInput['files']): Partial<Record<AgentManagedFileName, string>> {
  const result: Partial<Record<AgentManagedFileName, string>> = {};
  if (!value) return result;
  for (const [fileName, content] of Object.entries(value)) {
    if (isManagedAgentFileName(fileName) && typeof content === 'string') result[fileName] = content;
  }
  return result;
}

async function writeInitialFiles(
  profile: AgentProfile,
  actor: AgentManagementActor,
  files: Partial<Record<AgentManagedFileName, string>>,
): Promise<void> {
  for (const [fileName, content] of Object.entries(files)) {
    if (!isManagedAgentFileName(fileName) || !isWritableManagedAgentFileName(fileName, profile.agentId)) continue;
    await writeManagedAgentFile(fileName, content || '', profile.agentId, storageScope(profile, actor));
  }
}

export async function listManagedAgents(actor: AgentManagementActor): Promise<Array<AgentProfile & { access: AgentAccess }>> {
  const context = accessContext(actor);
  const [profiles, accessMap] = await Promise.all([
    listAgentProfiles(),
    listAgentAccessForUser(actor.userId, context),
  ]);
  return profiles.flatMap((profile) => {
    const access = accessMap.get(profile.agentId);
    return access?.canUse ? [{ ...profile, access }] : [];
  });
}

export async function inspectManagedAgent(
  actor: AgentManagementActor,
  agentId: string,
  options: { includeFiles?: boolean; includeAccess?: boolean } = {},
) {
  const profile = await requireProfile(actor, agentId, 'canUse');
  const access = await getAgentAccess(actor.userId, profile.agentId, accessContext(actor));
  const [bindings, snapshot] = await Promise.all([
    listAgentCapabilityBindings(profile.agentId),
    capabilitySnapshotForActor(actor),
  ]);
  const canInspectFiles = options.includeFiles && access.canEdit;
  const canInspectAccess = options.includeAccess && access.canManage;
  const [files, grants] = await Promise.all([
    canInspectFiles ? readManagedAgentFiles(profile.agentId, storageScope(profile, actor)) : Promise.resolve(undefined),
    canInspectAccess && profile.scopeType === 'organization' ? listAgentGrants(profile.agentId) : Promise.resolve(undefined),
  ]);
  return {
    agent: profile,
    access,
    bindings,
    readiness: readinessForBindings(bindings, snapshot),
    files,
    grants,
  };
}

export async function createManagedAgent(actor: AgentManagementActor, input: CreateManagedAgentInput) {
  actor = await verifiedManagementActor(actor);
  const scopeType = input.scopeType === 'organization' ? 'organization' : 'user';
  const { organizationId: actorOrganizationId } = await actorOrganization(actor);
  const organizationId = scopeType === 'organization'
    ? await requireOrganizationAdmin(actor)
    : actorOrganizationId;
  const enabledTools = Array.isArray(input.enabledTools) ? input.enabledTools : null;
  await validateSpecialAgentTools(enabledTools);
  await assertBrowserToolCanBeEnabled({ nextEnabledTools: enabledTools });
  const resolvedCapabilities = await resolveCapabilityBindings({
    actor,
    scopeType,
    capabilities: input.capabilities,
    relevantSkills: input.relevantSkills,
    relevantConnections: input.relevantConnections,
  });
  const defaultSelection = parseAgentDefaultFields({
    providerInstallationId: input.defaultProviderInstallationId,
    providerId: input.defaultProvider,
    modelId: input.defaultModel,
    thinkingLevel: input.defaultThinking,
  });
  if (defaultSelection && !organizationId) {
    throw new AgentManagementError('AGENT_ORGANIZATION_REQUIRED', 'An organization is required for agent model defaults.', 409);
  }

  let profile: AgentProfile | null = null;
  try {
    profile = await createAgentProfile({
      name: input.name,
      agentId: input.agentId,
      iconId: normalizeAgentIconId(input.iconId),
      enabledTools,
      relevantSkills: input.relevantSkills ?? null,
      relevantConnections: input.relevantConnections ?? null,
      accessPolicy: 'restricted',
      scopeType,
      organizationId,
      ownerUserId: scopeType === 'user' ? actor.userId : null,
      createdByUserId: actor.userId,
    });
    if (defaultSelection) {
      await writeAgentDefaultWithCatalogValidation({
        organizationId: organizationId!,
        agentId: profile.agentId,
        selection: defaultSelection,
        expectedCatalogRevision: parseAgentDefaultCatalogRevision(input.expectedCatalogRevision, true),
      });
      profile = (await getAgentProfile(profile.agentId)) || profile;
    }
    await replaceAgentCapabilityBindings(profile.agentId, resolvedCapabilities.bindings);
    if (scopeType === 'organization') {
      await createAgentManagerMembership(profile.agentId, actor.userId);
      for (const grant of input.grants || []) {
        await upsertAgentGrant({
          ...grant,
          agentId: profile.agentId,
          organizationId: organizationId!,
          actorUserId: actor.userId,
        });
      }
    } else if ((input.grants || []).length > 0) {
      throw new AgentManagementError('AGENT_PERSONAL_GRANTS_UNSUPPORTED', 'Personal agents cannot be shared.');
    }
    const files = normalizedFiles(input.files);
    await writeInitialFiles(profile, actor, files);
    profile = (await getAgentProfile(profile.agentId)) || profile;
    const access: AgentAccess = { canUse: true, canEdit: true, canManage: true };
    await auditAgentAction({
      actor,
      profile,
      agentId: profile.agentId,
      action: 'agent.create',
      metadata: {
        scopeType,
        capabilityCount: resolvedCapabilities.bindings.length,
        grantCount: input.grants?.length || 0,
        managedFiles: Object.keys(files),
      },
      input: {
        name: input.name,
        scopeType,
        enabledTools,
        capabilityResourceIds: resolvedCapabilities.bindings.map((binding) => binding.resourceId),
      },
      output: { agentId: profile.agentId, revision: profile.revision },
    });
    return {
      agent: profile,
      access,
      bindings: await listAgentCapabilityBindings(profile.agentId),
      readiness: readinessForBindings(await listAgentCapabilityBindings(profile.agentId), resolvedCapabilities.snapshot),
    };
  } catch (error) {
    if (profile) {
      await deleteAgentProfile(profile.agentId).catch(() => undefined);
      await deleteManagedAgentDefinitionStorage(profile.agentId, storageScope(profile, actor)).catch(() => undefined);
    }
    throw error;
  }
}

export async function updateManagedAgentProfile(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  name?: string | null;
  iconId?: AgentIconId | string | null;
}) {
  const { updateManagedAgentConfiguration } = await import('./workflow-configuration');
  return (await updateManagedAgentConfiguration(input, { auditAction: 'agent.update_profile' })).agent;
}

export async function updateManagedAgentRuntime(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  enabledTools?: string[] | null;
  defaultProviderInstallationId?: unknown;
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinking?: unknown;
  expectedCatalogRevision?: unknown;
}) {
  const { updateManagedAgentConfiguration } = await import('./workflow-configuration');
  return (await updateManagedAgentConfiguration(input, { auditAction: 'agent.update_runtime' })).agent;
}

export async function updateManagedAgentCapabilities(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  capabilities?: AgentCapabilitySelection[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
}) {
  const captured = structuredClone(input);
  const actor = await verifiedManagementActor(captured.actor);
  const preflight = await openDb();
  let preparedProfile: AgentProfile;
  let previous: AgentCapabilityBinding[];
  try {
    const profile = await readAgentProfileOnConnection(preflight, captured.agentId);
    if (!profile) throw new AgentManagementError('AGENT_NOT_FOUND', 'Agent not found.', 404);
    if (profile.workflowVersion != null) throw new AgentManagementError('AGENT_WORKFLOW_UPDATE_REQUIRED', 'Update the explicit workflow configuration to change its package bindings.', 409);
    if (profile.type === 'main') throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley\'s capabilities are managed by organization policy.', 403);
    const access = await getAgentAccessOnConnection(preflight, actor.userId, profile.agentId, accessContext(actor));
    if (!access.canEdit) throw new AgentManagementError('AGENT_ACCESS_DENIED', 'Agent access denied.', 403);
    ensureExpectedRevision(profile, captured.expectedRevision);
    preparedProfile = profile;
    previous = await listAgentCapabilityBindings(profile.agentId, preflight);
  } finally {
    await preflight.close();
  }
  const relevantSkills = captured.relevantSkills === undefined ? preparedProfile.relevantSkills : captured.relevantSkills;
  const relevantConnections = captured.relevantConnections === undefined ? preparedProfile.relevantConnections : captured.relevantConnections;
  const capabilities = captured.capabilities === undefined
    ? previous.filter((binding) => binding.resourceType === 'plugin').map((binding) => ({
      resourceType: 'plugin' as const, resourceId: binding.resourceId, name: binding.name, requirement: binding.requirement,
    }))
    : captured.capabilities;
  // Catalogue readers borrow their own connections. Complete them before holding
  // a write lease; the transaction then rechecks actor/agent rights and profile CAS.
  const resolved = await resolveCapabilityBindings({ actor,
    scopeType: preparedProfile.scopeType === 'organization' ? 'organization' : 'user', capabilities, relevantSkills, relevantConnections });
  const committed = await withAgentManagementWrite({ ...captured, actor, permission: 'canEdit' }, async (existing, currentActor, database) => {
    const agent = await updateAgentProfile({
      agentId: existing.agentId,
      expectedRevision: captured.expectedRevision,
      relevantSkills,
      relevantConnections,
    }, database);
    const bindings = await replaceAgentCapabilityBindings(existing.agentId, resolved.bindings, database);
    return { actor: currentActor, result: { agent, bindings, readiness: readinessForBindings(bindings, resolved.snapshot) } };
  });
  const { agent, bindings } = committed.result;
  await auditAgentAction({ actor: committed.actor, profile: agent, agentId: agent.agentId, action: 'agent.update_capabilities',
    input: { resourceIds: bindings.map((binding) => binding.resourceId) }, output: { revision: agent.revision } });
  return committed.result;
}

export async function updateManagedAgentFile(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  fileName: AgentManagedFileName | string;
  content: string;
}) {
  const existing = await requireProfile(input.actor, input.agentId, 'canEdit');
  if (existing.type === 'main') throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley\'s files are configured through the existing settings editor.', 403);
  ensureExpectedRevision(existing, input.expectedRevision);
  if (!isManagedAgentFileName(input.fileName) || !isWritableManagedAgentFileName(input.fileName, existing.agentId)) {
    throw new AgentManagementError('AGENT_FILE_INVALID', 'This managed agent file cannot be changed.');
  }
  const scope = storageScope(existing, input.actor);
  const previous = await readManagedAgentFile(input.fileName, existing.agentId, scope);
  await writeManagedAgentFile(input.fileName, input.content, existing.agentId, scope);
  try {
    const agent = await updateAgentProfile({ agentId: existing.agentId, expectedRevision: input.expectedRevision });
    await auditAgentAction({
      actor: input.actor,
      profile: agent,
      agentId: agent.agentId,
      action: 'agent.update_file',
      metadata: { fileName: input.fileName, contentLength: input.content.length },
      input: { fileName: input.fileName, contentHash: hashAuditValue(input.content) },
      output: { revision: agent.revision },
    });
    return { agent, fileName: input.fileName, content: input.content };
  } catch (error) {
    await writeManagedAgentFile(input.fileName, previous, existing.agentId, scope);
    throw error;
  }
}

export async function resetManagedAgentFiles(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  fileName?: AgentManagedFileName | string | null;
}) {
  const existing = await requireProfile(input.actor, input.agentId, 'canEdit');
  if (existing.type === 'main') {
    throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley\'s files are configured through the existing settings editor.', 403);
  }
  ensureExpectedRevision(existing, input.expectedRevision);
  const fileNames = input.fileName
    ? [input.fileName]
    : AGENT_MANAGED_FILE_NAMES.filter((fileName) => isWritableManagedAgentFileName(fileName, existing.agentId));
  if (fileNames.some((fileName) => !isManagedAgentFileName(fileName) || !isWritableManagedAgentFileName(fileName, existing.agentId))) {
    throw new AgentManagementError('AGENT_FILE_INVALID', 'This managed agent file cannot be reset.');
  }
  const scope = storageScope(existing, input.actor);
  const previous = new Map<AgentManagedFileName, string>();
  const results: Array<{ fileName: AgentManagedFileName; content: string }> = [];
  for (const fileName of fileNames as AgentManagedFileName[]) {
    previous.set(fileName, await readManagedAgentFile(fileName, existing.agentId, scope));
    results.push({ fileName, content: await resetManagedAgentFile(fileName, existing.agentId, scope) });
  }
  try {
    const agent = await updateAgentProfile({ agentId: existing.agentId, expectedRevision: input.expectedRevision });
    await auditAgentAction({
      actor: input.actor,
      profile: agent,
      agentId: agent.agentId,
      action: 'agent.reset_files',
      metadata: { fileNames },
      output: { revision: agent.revision },
    });
    return { agent, files: results };
  } catch (error) {
    for (const [fileName, content] of previous) {
      await writeManagedAgentFile(fileName, content, existing.agentId, scope);
    }
    throw error;
  }
}

export async function setManagedAgentGrant(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  targetType: AgentGrantTargetType;
  targetId: string;
  canUse?: boolean;
  canEdit?: boolean;
  canManage?: boolean;
}) {
  const captured = structuredClone(input);
  const committed = await withAgentManagementWrite({ ...captured, permission: 'canManage' }, async (existing, actor, database) => {
    if (existing.scopeType !== 'organization' || !existing.organizationId) {
      throw new AgentManagementError('AGENT_PERSONAL_GRANTS_UNSUPPORTED', 'Personal agents cannot be shared.');
    }
    const grant = await upsertAgentGrant({ ...captured, organizationId: existing.organizationId, actorUserId: actor.userId }, database);
    const agent = await updateAgentProfile({ agentId: existing.agentId, expectedRevision: captured.expectedRevision }, database);
    return { actor, result: { agent, grant } };
  });
  const { agent } = committed.result;
  await auditAgentAction({ actor: committed.actor, profile: agent, agentId: agent.agentId, action: 'agent.set_grant',
    input: captured, output: { revision: agent.revision } });
  return committed.result;
}

export async function removeManagedAgentGrant(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  targetType: AgentGrantTargetType;
  targetId: string;
}) {
  const captured = structuredClone(input);
  const committed = await withAgentManagementWrite({ ...captured, permission: 'canManage' }, async (existing, actor, database) => {
    if (existing.scopeType !== 'organization') {
      throw new AgentManagementError('AGENT_PERSONAL_GRANTS_UNSUPPORTED', 'Personal agents cannot be shared.');
    }
    const previous = (await listAgentGrants(existing.agentId, database)).find((grant) => (
      grant.targetType === captured.targetType && grant.targetId === captured.targetId));
    await removeAgentGrant(captured, database);
    const agent = await updateAgentProfile({ agentId: existing.agentId, expectedRevision: captured.expectedRevision }, database);
    return { actor, result: { agent, removed: Boolean(previous) } };
  });
  const { agent } = committed.result;
  await auditAgentAction({ actor: committed.actor, profile: agent, agentId: agent.agentId, action: 'agent.remove_grant',
    input: captured, output: { revision: agent.revision } });
  return committed.result;
}

export async function previewManagedAgentDeletion(actor: AgentManagementActor, agentId: string) {
  const profile = await requireProfile(actor, agentId, 'canManage');
  if (profile.agentId === DEFAULT_MANAGED_AGENT_ID || !profile.removable) {
    throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley cannot be deleted.', 403);
  }
  const database = await openDb();
  try {
    const [sessions, members, grants, bindings, memoryCollections, memoryEntries] = await Promise.all([
      database.get(`SELECT COUNT(*) AS count FROM pi_sessions WHERE agent_id = $1`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM agent_members WHERE agent_id = $1`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM agent_grants WHERE agent_id = $1`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM agent_capability_bindings WHERE agent_id = $1`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM memory_collections WHERE scope_type = 'agent' AND agent_id = $1`, [profile.agentId]),
      database.get(`
        SELECT COUNT(entry.id) AS count FROM memory_entries entry
        INNER JOIN memory_collections collection ON collection.id = entry.collection_id
        WHERE collection.scope_type = 'agent' AND collection.agent_id = $1
      `, [profile.agentId]),
    ]) as Array<{ count?: number | string }>;
    const impacts = {
      sessions: Number(sessions?.count || 0),
      members: Number(members?.count || 0),
      grants: Number(grants?.count || 0),
      capabilityBindings: Number(bindings?.count || 0),
      memoryCollections: Number(memoryCollections?.count || 0),
      memoryEntries: Number(memoryEntries?.count || 0),
      memoryPolicy: 'retained' as const,
      managedFiles: AGENT_MANAGED_FILE_NAMES.filter((fileName) => isWritableManagedAgentFileName(fileName, profile.agentId)),
    };
    return {
      agent: profile,
      impacts,
      confirmationToken: createAgentDeleteConfirmationToken({
        agentId: profile.agentId,
        actorUserId: actor.userId,
        revision: profile.revision,
      }),
      expiresInSeconds: 600,
    };
  } finally {
    await database.close();
  }
}

export async function deleteManagedAgent(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  confirmationToken: string;
}) {
  const profile = await requireProfile(input.actor, input.agentId, 'canManage');
  if (profile.agentId === DEFAULT_MANAGED_AGENT_ID || !profile.removable) {
    throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley cannot be deleted.', 403);
  }
  ensureExpectedRevision(profile, input.expectedRevision);
  verifyAgentDeleteConfirmationToken(input.confirmationToken, {
    agentId: profile.agentId,
    actorUserId: input.actor.userId,
    revision: profile.revision,
  });
  await deleteAgentProfile(profile.agentId, input.expectedRevision);
  await deleteManagedAgentDefinitionStorage(profile.agentId, storageScope(profile, input.actor));
  await auditAgentAction({ actor: input.actor, profile, agentId: profile.agentId, action: 'agent.delete', input: { revision: profile.revision } });
  return { deleted: true, agentId: profile.agentId };
}

export function managementErrorDetails(error: unknown): { code: string; message: string; status: number; details?: Record<string, unknown> } {
  if (error instanceof AgentManagementError) {
    return { code: error.code, message: error.message, status: error.status, details: error.details };
  }
  if (error instanceof AgentRevisionConflictError) {
    return { code: error.code, message: error.message, status: 409, details: { currentRevision: error.currentRevision } };
  }
  const integrationCode = readIntegrationContractErrorCode(error);
  if (integrationCode) {
    const status = integrationCode === 'provider_denied' || integrationCode === 'tool_denied' ? 403
      : integrationCode === 'binding_changed' || integrationCode === 'schema_changed' || integrationCode === 'outcome_unknown' ? 409
        : integrationCode === 'tool_not_found' ? 404 : integrationCode === 'provider_unavailable' ? 503 : 400;
    return { code: integrationCode, message: INTEGRATION_GATEWAY_ERROR_MESSAGES[integrationCode], status };
  }
  if (error instanceof AgentDefaultPolicyError || error instanceof AiRuntimeInputError
    || isAgentActorContextError(error) || isAgentWorkflowError(error)
    || isCapabilityPackageError(error) || error instanceof CapabilityResourceError || isIntegrationConnectionError(error)) {
    return { code: error.code, message: error.message, status: error.status,
      ...(error instanceof AgentDefaultPolicyError && typeof error.currentCatalogRevision === 'number'
        ? { details: { currentCatalogRevision: error.currentCatalogRevision } } : {}) };
  }
  // SQL/provider errors can contain private query parameters and account bindings.
  return { code: 'AGENT_MANAGEMENT_FAILED', message: 'Agent management failed. Reload and try again.', status: 500 };
}
