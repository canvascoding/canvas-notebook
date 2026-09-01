import 'server-only';

import { hashAuditValue, recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  parseAgentDefaultCatalogRevision,
  parseAgentDefaultFields,
  writeAgentDefaultWithCatalogValidation,
} from '@/app/lib/agent-runtime-policy/agent-default-service';
import {
  createAgentManagerMembership,
  getAgentAccess,
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
  type AgentProfile,
} from '@/app/lib/agents/registry';
import {
  AGENT_MANAGED_FILE_NAMES,
  DEFAULT_MANAGED_AGENT_ID,
  EMAIL_MANAGED_AGENT_ID,
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
import { openDb } from '@/app/lib/db';
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
  const agentId = normalizeManagedAgentId(agentIdInput);
  const profile = await getAgentProfile(agentId);
  if (!profile) throw new AgentManagementError('AGENT_NOT_FOUND', 'Agent not found.', 404);
  await requireAgentAccess(actor.userId, agentId, permission, accessContext(actor));
  return profile;
}

async function auditAgentAction(input: {
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

async function resolveCapabilityBindings(input: {
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

async function validateSpecialAgentTools(enabledTools: string[] | null | undefined): Promise<void> {
  if (!enabledTools) return;
  const protectedAgentTools = new Set([
    'agent_manage',
    'list_agents',
    'inspect_agent',
    'create_agent',
    'update_agent_profile',
    'update_agent_runtime',
    'update_agent_capabilities',
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
  const existing = await requireProfile(input.actor, input.agentId, 'canEdit');
  if (existing.type === 'main') throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley\'s profile is protected.', 403);
  ensureExpectedRevision(existing, input.expectedRevision);
  const agent = await updateAgentProfile({
    agentId: existing.agentId,
    expectedRevision: input.expectedRevision,
    name: input.name,
    iconId: input.iconId === undefined ? undefined : normalizeAgentIconId(input.iconId),
  });
  await auditAgentAction({ actor: input.actor, profile: agent, agentId: agent.agentId, action: 'agent.update_profile', input, output: { revision: agent.revision } });
  return agent;
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
  const existing = await requireProfile(input.actor, input.agentId, 'canEdit');
  if (existing.type === 'main') throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley\'s runtime is configured in app settings.', 403);
  ensureExpectedRevision(existing, input.expectedRevision);
  const nextEnabledTools = input.enabledTools === undefined ? existing.enabledTools : input.enabledTools;
  if (input.enabledTools !== undefined) {
    if (existing.agentId === EMAIL_MANAGED_AGENT_ID) {
      await requireOrganizationAdmin(input.actor);
    }
    await validateSpecialAgentTools(input.enabledTools);
  }
  await assertBrowserToolCanBeEnabled({ previousEnabledTools: existing.enabledTools, nextEnabledTools });
  const changesDefault = [
    input.defaultProviderInstallationId,
    input.defaultProvider,
    input.defaultModel,
    input.defaultThinking,
  ].some((value) => value !== undefined);
  if (changesDefault) {
    const organizationId = await requireOrganizationAdmin(input.actor);
    if (existing.organizationId && existing.organizationId !== organizationId) {
      throw new AgentManagementError('AGENT_ORGANIZATION_MISMATCH', 'Agent belongs to another organization.', 403);
    }
    const selection = parseAgentDefaultFields({
      providerInstallationId: input.defaultProviderInstallationId === undefined
        ? existing.defaultProviderInstallationId
        : input.defaultProviderInstallationId,
      providerId: input.defaultProvider === undefined ? existing.defaultProvider : input.defaultProvider,
      modelId: input.defaultModel === undefined ? existing.defaultModel : input.defaultModel,
      thinkingLevel: input.defaultThinking === undefined ? existing.defaultThinking : input.defaultThinking,
    });
    await writeAgentDefaultWithCatalogValidation({
      organizationId,
      agentId: existing.agentId,
      selection,
      expectedCatalogRevision: selection
        ? parseAgentDefaultCatalogRevision(input.expectedCatalogRevision, true)
        : undefined,
    });
  }
  const agent = await updateAgentProfile({
    agentId: existing.agentId,
    expectedRevision: input.expectedRevision,
    enabledTools: input.enabledTools,
  });
  await auditAgentAction({ actor: input.actor, profile: agent, agentId: agent.agentId, action: 'agent.update_runtime', input, output: { revision: agent.revision } });
  return agent;
}

export async function updateManagedAgentCapabilities(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  capabilities?: AgentCapabilitySelection[] | null;
  relevantSkills?: string[] | null;
  relevantConnections?: string[] | null;
}) {
  const existing = await requireProfile(input.actor, input.agentId, 'canEdit');
  if (existing.type === 'main') throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley\'s capabilities are managed by organization policy.', 403);
  ensureExpectedRevision(existing, input.expectedRevision);
  const previous = await listAgentCapabilityBindings(existing.agentId);
  const relevantSkills = input.relevantSkills === undefined
    ? existing.relevantSkills
    : input.relevantSkills;
  const relevantConnections = input.relevantConnections === undefined
    ? existing.relevantConnections
    : input.relevantConnections;
  const capabilities = input.capabilities === undefined
    ? previous
      .filter((binding) => binding.resourceType === 'plugin')
      .map((binding) => ({
        resourceType: 'plugin' as const,
        resourceId: binding.resourceId,
        name: binding.name,
        requirement: binding.requirement,
      }))
    : input.capabilities;
  const resolved = await resolveCapabilityBindings({
    actor: input.actor,
    scopeType: existing.scopeType === 'organization' ? 'organization' : 'user',
    capabilities,
    relevantSkills,
    relevantConnections,
  });
  await replaceAgentCapabilityBindings(existing.agentId, resolved.bindings);
  try {
    const agent = await updateAgentProfile({
      agentId: existing.agentId,
      expectedRevision: input.expectedRevision,
      relevantSkills,
      relevantConnections,
    });
    const bindings = await listAgentCapabilityBindings(existing.agentId);
    await auditAgentAction({
      actor: input.actor,
      profile: agent,
      agentId: agent.agentId,
      action: 'agent.update_capabilities',
      input: { resourceIds: resolved.bindings.map((binding) => binding.resourceId) },
      output: { revision: agent.revision },
    });
    return { agent, bindings, readiness: readinessForBindings(bindings, resolved.snapshot) };
  } catch (error) {
    await replaceAgentCapabilityBindings(existing.agentId, previous.map((binding) => ({
      resourceType: binding.resourceType,
      scopeType: binding.scopeType,
      resourceId: binding.resourceId,
      name: binding.name,
      version: binding.version,
      requirement: binding.requirement,
    })));
    throw error;
  }
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
  const existing = await requireProfile(input.actor, input.agentId, 'canManage');
  if (existing.scopeType !== 'organization' || !existing.organizationId) {
    throw new AgentManagementError('AGENT_PERSONAL_GRANTS_UNSUPPORTED', 'Personal agents cannot be shared.');
  }
  ensureExpectedRevision(existing, input.expectedRevision);
  const previous = (await listAgentGrants(existing.agentId)).find((grant) => (
    grant.targetType === input.targetType && grant.targetId === input.targetId
  ));
  const grant = await upsertAgentGrant({
    ...input,
    organizationId: existing.organizationId,
    actorUserId: input.actor.userId,
  });
  try {
    const agent = await updateAgentProfile({ agentId: existing.agentId, expectedRevision: input.expectedRevision });
    await auditAgentAction({ actor: input.actor, profile: agent, agentId: agent.agentId, action: 'agent.set_grant', input, output: { revision: agent.revision } });
    return { agent, grant };
  } catch (error) {
    if (previous) {
      await upsertAgentGrant({ ...previous, actorUserId: previous.updatedByUserId });
    } else {
      await removeAgentGrant(input);
    }
    throw error;
  }
}

export async function removeManagedAgentGrant(input: {
  actor: AgentManagementActor;
  agentId: string;
  expectedRevision: number;
  targetType: AgentGrantTargetType;
  targetId: string;
}) {
  const existing = await requireProfile(input.actor, input.agentId, 'canManage');
  if (existing.scopeType !== 'organization') {
    throw new AgentManagementError('AGENT_PERSONAL_GRANTS_UNSUPPORTED', 'Personal agents cannot be shared.');
  }
  ensureExpectedRevision(existing, input.expectedRevision);
  const previous = (await listAgentGrants(existing.agentId)).find((grant) => (
    grant.targetType === input.targetType && grant.targetId === input.targetId
  ));
  await removeAgentGrant(input);
  try {
    const agent = await updateAgentProfile({ agentId: existing.agentId, expectedRevision: input.expectedRevision });
    await auditAgentAction({ actor: input.actor, profile: agent, agentId: agent.agentId, action: 'agent.remove_grant', input, output: { revision: agent.revision } });
    return { agent, removed: Boolean(previous) };
  } catch (error) {
    if (previous) await upsertAgentGrant({ ...previous, actorUserId: previous.updatedByUserId });
    throw error;
  }
}

export async function previewManagedAgentDeletion(actor: AgentManagementActor, agentId: string) {
  const profile = await requireProfile(actor, agentId, 'canManage');
  if (profile.agentId === DEFAULT_MANAGED_AGENT_ID || !profile.removable) {
    throw new AgentManagementError('AGENT_MAIN_PROTECTED', 'Bradley cannot be deleted.', 403);
  }
  const database = await openDb();
  try {
    const [sessions, members, grants, bindings] = await Promise.all([
      database.get(`SELECT COUNT(*) AS count FROM pi_sessions WHERE agent_id = ?`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM agent_members WHERE agent_id = ?`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM agent_grants WHERE agent_id = ?`, [profile.agentId]),
      database.get(`SELECT COUNT(*) AS count FROM agent_capability_bindings WHERE agent_id = ?`, [profile.agentId]),
    ]) as Array<{ count?: number | string }>;
    const impacts = {
      sessions: Number(sessions?.count || 0),
      members: Number(members?.count || 0),
      grants: Number(grants?.count || 0),
      capabilityBindings: Number(bindings?.count || 0),
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
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown; currentCatalogRevision?: unknown };
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'AGENT_MANAGEMENT_FAILED',
    message: typeof candidate?.message === 'string' ? candidate.message : 'Agent management failed.',
    status: typeof candidate?.status === 'number' ? candidate.status : 400,
    details: typeof candidate?.currentCatalogRevision === 'number'
      ? { currentCatalogRevision: candidate.currentCatalogRevision }
      : undefined,
  };
}
