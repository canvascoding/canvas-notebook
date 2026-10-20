import 'server-only';

import { openDb } from '@/app/lib/db';
import { listCapabilityResources } from '@/app/lib/capabilities/resources/actions';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import { CapabilityResourceError, type CapabilityResourceDescriptor } from '@/app/lib/capabilities/resources/contracts';
import { getCapabilityPackagePublishedRevision, listCapabilityPackagePublishedRevisions } from '@/app/lib/capabilities/packages/store';
import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { isComposioIntegrationApplicationVisible } from '@/app/lib/integration-tools/adapters/composio';
import { authorizeIntegrationConnectionBindingsOnConnection, lockIntegrationConnectionBindingsOnConnection,
  type IntegrationConnectionBindingAuthorization } from '@/app/lib/integration-tools/connections/store';
import { isIntegrationConnectionError } from '@/app/lib/integration-tools/connections/contracts';
import { verifyStoredPersonalWorkflowProviderTarget } from '@/app/lib/integration-tools/workflow-personal-bindings';
import { listMcpServerDefinitions } from '@/app/lib/mcp/server-definitions';
import { resolveSharedMcpBackend } from '@/app/lib/mcp/shared-connections';
import { hashMcpLegacyConfig } from '@/app/lib/mcp/connection-identity';
import type { WorkflowIntegrationAlternative } from '@/app/lib/capabilities/workflow-contracts';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import type { AgentManagementActor } from './management-actions';
import { readManagedAgentWorkflow, readManagedAgentWorkflowOnConnection, holdAgentGrantAuthority } from './workflow-configuration';
import { getAgentAccessOnConnection } from './access';
import { EMAIL_MANAGED_AGENT_ID } from './storage';
import { readAgentExtensionPackageVersion } from './extension-package-options';
import { createRetainedAgentWorkflowTarget, type AgentWorkflowBindingSlot } from './workflow-binding-retention';
import { enumerateOwnAgentWorkflowProviders } from './workflow-personal-options';
import { AgentWorkflowError, parseAgentWorkflowConfiguration, type AgentWorkflowInternalSnapshot, type AgentWorkflowTarget,
  type AgentWorkflowPackageConfiguration, type StoredAgentWorkflowTarget } from './workflow-contracts';
import { agentWorkflowManagementRequestSchema, type AgentWorkflowManagementRequest, type AgentWorkflowManagementHeader,
  type AgentWorkflowManagementOptions, type AgentWorkflowManagementPackageVersion, type AgentWorkflowPackageOption,
  type AgentWorkflowManagementConnection, type AgentWorkflowManagementBindingSummary } from './workflow-management-contracts';

type Manager = { actor: AgentManagementActor; organizationId: string | null; snapshot: AgentWorkflowInternalSnapshot };
type Followup = Exclude<AgentWorkflowManagementRequest, { view: 'management' }>;
type SlotRequest = Extract<AgentWorkflowManagementRequest, { view: 'connections' | 'personal-connections' | 'personal-mcp-definitions' }>;
function fail(code: string, message: string, status = 409): never { throw new AgentWorkflowError(code, message, status); }
function label(value: string, fallback: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 256) || fallback; }
function alternativeKey(value: WorkflowIntegrationAlternative): string { return `${value.source}:${value.source === 'mcp' ? value.connector : value.toolkit}`; }
function unavailable(error: unknown): boolean {
  return error instanceof CapabilityResourceError || isCapabilityPackageError(error) || isIntegrationConnectionError(error)
    || error instanceof AgentWorkflowError || Boolean(error && typeof error === 'object' && Reflect.get(error, Symbol.for('canvas.integration.contract-error.v1')) === true);
}
function header(manager: Manager): AgentWorkflowManagementHeader {
  return { schemaVersion: 1, agentId: manager.snapshot.agent.agentId, revision: manager.snapshot.agent.revision, workflowRevision: manager.snapshot.workflowRevision };
}
async function manager(actorInput: AgentManagementActor, agentId: string, expected?: Followup): Promise<Manager> {
  const captured = structuredClone(actorInput), database = await openDb();
  let actor: AgentManagementActor, organizationId: string | null, organizationRole: string | null;
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(captured, database);
    organizationId = verified.organizationId;
    organizationRole = verified.organizationRole;
    actor = { ...captured, organizationId: verified.context.organizationId, workspaceId: verified.context.workspaceId, projectId: verified.context.projectId };
  } finally { await database.close(); }
  const snapshot = await readManagedAgentWorkflow(actor, agentId);
  if (!snapshot.access.canEdit) fail('AGENT_ACCESS_DENIED', 'Current agent editing permission is required.', 403);
  if (snapshot.agent.agentId === EMAIL_MANAGED_AGENT_ID && !['owner', 'admin'].includes(organizationRole ?? '')) {
    fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required to configure the email agent.', 403);
  }
  if (snapshot.agent.type === 'main') fail('AGENT_MAIN_PROTECTED', 'The built-in main agent is configured through organization policy.', 403);
  if (expected && (snapshot.agent.revision !== expected.expectedRevision || snapshot.workflowRevision !== expected.expectedWorkflowRevision)) {
    fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload it before selecting its bindings.');
  }
  return { actor, organizationId, snapshot };
}
async function finalManager(initial: Manager): Promise<void> {
  const current = await manager(initial.actor, initial.snapshot.agent.agentId);
  if (current.snapshot.agent.revision !== initial.snapshot.agent.revision || current.snapshot.workflowRevision !== initial.snapshot.workflowRevision
    || current.organizationId !== initial.organizationId) {
    fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload it before selecting its bindings.');
  }
}
function packageAllowed(resource: CapabilityResourceDescriptor, current: Manager): boolean {
  return resource.metadata.status === 'active' && resource.access.canRead && resource.access.canUse && resource.artifact.sourceType !== 'plugin'
    && resource.activation?.effectivePolicy !== 'blocked' && resource.activation?.readiness !== 'conflict'
    && (current.snapshot.agent.scopeType !== 'organization' || resource.artifact.scopeType !== 'user');
}
async function packageDescriptor(current: Manager, reference: string): Promise<CapabilityResourceDescriptor> {
  const resource = (await listCapabilityResources({ userId: current.actor.userId, workspaceId: current.actor.workspaceId }))
    .find(value => value.metadata.resourceRef === reference);
  if (!resource || !packageAllowed(resource, current)) fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is unavailable for this agent.', 403);
  return resource;
}
async function versions(current: Manager, reference: string) {
  const record = await findCapabilityResourceRecord(reference);
  if (!record) fail('AGENT_WORKFLOW_PACKAGE_UNAVAILABLE', 'Publish the package before selecting a workflow version.');
  return withAuthorizedCapabilityPackageResource({ userId: current.actor.userId, workspaceId: current.actor.workspaceId }, record.storage, 'use', undefined,
    async (authorization, database) => listCapabilityPackagePublishedRevisions(authorization.record.metadata.resourceRef, database));
}
async function verifyPin(current: Manager, reference: string, published: string, checksum?: string) {
  await packageDescriptor(current, reference);
  const record = await findCapabilityResourceRecord(reference);
  if (!record) fail('AGENT_WORKFLOW_PACKAGE_UNAVAILABLE', 'The selected published package version is unavailable.');
  const selected = await withAuthorizedCapabilityPackageResource({ userId: current.actor.userId, workspaceId: current.actor.workspaceId }, record.storage, 'use', undefined,
    async (authorization, database) => getCapabilityPackagePublishedRevision(authorization.record.metadata.resourceRef, published, database));
  if (!selected || checksum !== undefined && selected.checksum !== checksum) fail('AGENT_WORKFLOW_PACKAGE_CHANGED', 'The selected published package version is unavailable.');
  return selected;
}
async function packageVersion(current: Manager, request: { resourceRef: string; publishedRevisionRef: string }): Promise<AgentWorkflowManagementPackageVersion> {
  await packageDescriptor(current, request.resourceRef);
  const { metadata } = await readAgentExtensionPackageVersion({ userId: current.actor.userId, workspaceId: current.actor.workspaceId },
    { resourceRef: request.resourceRef, publishedRevisionRef: request.publishedRevisionRef },
    { allowPersonalPackages: current.snapshot.agent.scopeType !== 'organization' });
  return { ...header(current), view: 'package-version', resourceRef: metadata.resourceRef, publishedRevisionRef: metadata.publishedRevisionRef,
    checksum: metadata.checksum, kind: metadata.kind, name: metadata.name, version: metadata.version,
    skillRoots: metadata.skillRoots.map(({ name, relativeRoot }) => ({ name, relativeRoot })), declarations: metadata.declarations };
}
async function declaredAlternative(current: Manager, request: SlotRequest) {
  const pkg = await packageVersion(current, request);
  const declaration = pkg.declarations.find(value => value.declarationPath === request.declarationPath);
  const capability = declaration?.workflow.integrationCapabilities.find(value => value.id === request.capabilityId);
  const alternative = capability?.alternatives.find(value => alternativeKey(value) === request.alternativeKey);
  if (!alternative || alternative.source === 'composio' && !isComposioIntegrationApplicationVisible(alternative.toolkit)) {
    fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'Choose an exact declared integration alternative.', 400);
  }
  return alternative;
}
async function authorizeShared(current: Manager, references: string[]): Promise<IntegrationConnectionBindingAuthorization[]> {
  if (!references.length) return [];
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(current.actor, database, { lock: true });
    const batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: current.actor.userId, ...verified.context }, references);
    await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [current.snapshot.agent.agentId]);
    const fresh = await readManagedAgentWorkflowOnConnection(database, current.snapshot.agent.agentId);
    if (fresh.agent.revision !== current.snapshot.agent.revision || fresh.workflowRevision !== current.snapshot.workflowRevision) {
      fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload its connections.');
    }
    if (!(await getAgentAccessOnConnection(database, current.actor.userId, fresh.agent.agentId, verified.context)).canEdit) {
      fail('AGENT_ACCESS_DENIED', 'Current agent editing permission is required.', 403);
    }
    const authorized = await authorizeIntegrationConnectionBindingsOnConnection(database, batch, fresh.agent, 'configure');
    await database.run('COMMIT'); return authorized;
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
}
function targetMatches(binding: IntegrationConnectionBindingAuthorization, target: Extract<StoredAgentWorkflowTarget, { kind: 'shared' }>,
  alternative: WorkflowIntegrationAlternative, toolCap: readonly string[] | null): boolean {
  return binding.resource.source === target.source && binding.resource.source === alternative.source && binding.resource.bindingRevision === target.bindingRevision
    && (alternative.source !== 'mcp' || binding.canManage)
    && (alternative.source !== 'composio' || binding.backend.source === 'composio' && binding.backend.toolkit === alternative.toolkit)
    && (alternative.requiredTools ?? []).every(name => (toolCap === null || toolCap.includes(name))
      && (binding.allowedToolNames === null || binding.allowedToolNames.includes(name)));
}
async function publicTarget(current: Manager, target: StoredAgentWorkflowTarget, slot: AgentWorkflowBindingSlot,
  alternative: WorkflowIntegrationAlternative, toolCap: readonly string[] | null): Promise<AgentWorkflowTarget> {
  if (alternative.source === 'composio' && !isComposioIntegrationApplicationVisible(alternative.toolkit)) {
    fail('AGENT_WORKFLOW_BINDING_DENIED', 'The configured integration alternative is unavailable.', 403);
  }
  if (target.kind === 'shared') {
    const [binding] = await authorizeShared(current, [target.connectionRef]);
    if (!binding || !targetMatches(binding, target, alternative, toolCap)) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The configured connection is unavailable.');
    if (alternative.source === 'mcp') {
      const backend = await resolveSharedMcpBackend({ userId: current.actor.userId,
        workspaceId: current.actor.workspaceId, organizationId: current.actor.organizationId }, target.connectionRef, 'manage');
      if (!target.verifiedMcpMapping || target.verifiedMcpMapping.connector !== alternative.connector
        || hashMcpLegacyConfig(backend.connection) !== target.verifiedMcpMapping.configFingerprint) {
        fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The configured MCP mapping is unavailable.');
      }
      if (target.verifiedMcpMapping.definitionId) {
        const definition = (await listMcpServerDefinitions(binding.resource.ownership.organizationId))
          .find(value => value.id === target.verifiedMcpMapping!.definitionId);
        if (!definition?.enabled || definition.revision !== target.verifiedMcpMapping.definitionRevision) fail('AGENT_WORKFLOW_BINDING_CHANGED', 'The configured MCP definition changed.');
      }
      const retained = createRetainedAgentWorkflowTarget(current.actor, current.snapshot, slot);
      if (!retained) fail('AGENT_WORKFLOW_RETENTION_INVALID', 'The existing MCP approval cannot be retained.');
      return retained;
    }
    return { kind: 'shared', source: target.source, connectionRef: target.connectionRef, bindingRevision: target.bindingRevision,
      ...(target.mcpMapping ? { mcpMapping: { kind: 'manager_confirmation' as const } } : {}) };
  }
  if (target.kind !== 'personal' || current.snapshot.agent.scopeType === 'organization' || target.ownerUserId !== current.actor.userId || !target.personalBinding) {
    fail('AGENT_WORKFLOW_BINDING_DENIED', 'The configured personal connection is unavailable.', 403);
  }
  await verifyStoredPersonalWorkflowProviderTarget({ actor: current.actor, target: { binding: target.personalBinding, baseProviderRef: target.providerRef,
    boundProviderRef: target.boundProviderRef!, bindingFingerprint: target.bindingFingerprint! } }, { checkProviderReadiness: false });
  const retained = createRetainedAgentWorkflowTarget(current.actor, current.snapshot, slot);
  if (!retained) fail('AGENT_WORKFLOW_RETENTION_INVALID', 'The existing personal binding cannot be retained.');
  return retained;
}
type ReadPin = { resourceRef: string; revisionRef: string; checksum: string };
type ReadTarget = { key: string; target: StoredAgentWorkflowTarget; alternative: WorkflowIntegrationAlternative; toolCap: readonly string[] | null };
type FinalReadState = { current: Manager; unavailablePackages: Set<string>; unavailableTargets: Set<string>;
  validPins: Set<string>; connections: Map<string, IntegrationConnectionBindingAuthorization> };
function pinKey(pin: ReadPin): string { return JSON.stringify([pin.resourceRef, pin.revisionRef, pin.checksum]); }
function configuredReadTargets(current: Manager): ReadTarget[] {
  return current.snapshot.bindings.flatMap(binding => binding.configuration ? binding.configuration.declarations.flatMap(declaration =>
    declaration.capabilities.flatMap(capability => {
      const choices = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
      return choices.map(choice => ({ key: JSON.stringify([binding.configuration!.resourceRef, declaration.declarationPath, capability.capabilityId]),
        target: choice.target, alternative: capability.alternatives.find(value => alternativeKey(value) === choice.alternativeKey)!, toolCap: choice.toolCap }));
    })) : []);
}
async function finalReadLease<T>(initial: Manager, pins: readonly ReadPin[], targets: readonly ReadTarget[],
  callback: (state: FinalReadState) => T): Promise<T> {
  const resourceRefs = [...new Set(pins.map(pin => pin.resourceRef))];
  const records = await Promise.all(resourceRefs.map(async ref => ({ ref, record: await findCapabilityResourceRecord(ref) })));
  records.sort((left, right) => (left.record?.storage.resourceId ?? left.ref).localeCompare(right.record?.storage.resourceId ?? right.ref));
  const connectionRefs = [...new Set(targets.flatMap(value => value.target.kind === 'shared' ? [value.target.connectionRef] : []))].sort();
  const database = await openDb();
  const state: FinalReadState = { current: initial, unavailablePackages: new Set(), unavailableTargets: new Set(), validPins: new Set(), connections: new Map() };
  try {
    await database.run('BEGIN');
    const verified = await resolveVerifiedAgentActorContextOnConnection(initial.actor, database, { lock: true });
    if (verified.organizationId !== initial.organizationId) fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The current agent context changed.');
    let batch: Awaited<ReturnType<typeof lockIntegrationConnectionBindingsOnConnection>> | undefined;
    if (connectionRefs.length) {
      try { batch = await lockIntegrationConnectionBindingsOnConnection(database, { userId: initial.actor.userId, ...verified.context }, connectionRefs); }
      catch (error) { if (!isIntegrationConnectionError(error)) throw error;
        for (const value of targets) if (value.target.kind === 'shared') state.unavailableTargets.add(value.key); }
    }
    const personal = targets.filter(value => value.target.kind === 'personal');
    const profileIds = [...new Set(personal.flatMap(value => value.target.kind === 'personal' && value.target.personalBinding?.source === 'composio'
      ? [value.target.personalBinding.profileId] : []))].sort();
    for (const profileId of profileIds) {
      const row = await database.get('SELECT owner_user_id,scope_type,status FROM composio_connection_profiles WHERE id=$1 FOR SHARE', [profileId]) as Record<string, unknown> | undefined;
      if (!row || row.owner_user_id !== initial.actor.userId || row.scope_type !== 'user' || row.status !== 'active') {
        for (const value of personal) if (value.target.kind === 'personal' && value.target.personalBinding?.source === 'composio'
          && value.target.personalBinding.profileId === profileId) state.unavailableTargets.add(value.key);
      }
    }
    const finish = async (): Promise<T> => {
      await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [initial.snapshot.agent.agentId]);
      const snapshot = await readManagedAgentWorkflowOnConnection(database, initial.snapshot.agent.agentId);
      await holdAgentGrantAuthority(database, initial.actor, snapshot.agent);
      const access = await getAgentAccessOnConnection(database, initial.actor.userId, snapshot.agent.agentId, verified.context);
      if (!access.canEdit) fail('AGENT_ACCESS_DENIED', 'Current agent editing permission is required.', 403);
      if (snapshot.agent.agentId === EMAIL_MANAGED_AGENT_ID && !['owner', 'admin'].includes(verified.organizationRole ?? '')) {
        fail('AGENT_ORGANIZATION_ADMIN_REQUIRED', 'Organization administration is required to configure the email agent.', 403);
      }
      if (snapshot.agent.revision !== initial.snapshot.agent.revision || snapshot.workflowRevision !== initial.snapshot.workflowRevision) {
        fail('AGENT_WORKFLOW_REVISION_CONFLICT', 'The agent configuration changed. Reload it before selecting its bindings.');
      }
      snapshot.access = { ...access };
      state.current = { ...initial, snapshot };
      if (batch) {
        try {
          for (const connection of await authorizeIntegrationConnectionBindingsOnConnection(database, batch, snapshot.agent, 'configure')) {
            state.connections.set(connection.resource.connectionRef, connection);
          }
        } catch (error) {
          if (!isIntegrationConnectionError(error)) throw error;
          for (const value of targets) if (value.target.kind === 'shared') state.unavailableTargets.add(value.key);
        }
      }
      for (const value of targets) {
        if (value.target.kind === 'shared') {
          const connection = state.connections.get(value.target.connectionRef);
          if (!connection || !targetMatches(connection, value.target, value.alternative, value.toolCap)) state.unavailableTargets.add(value.key);
        } else if (value.target.ownerUserId !== initial.actor.userId) state.unavailableTargets.add(value.key);
      }
      return callback(state);
    };
    const holdPackages = async (index: number): Promise<T> => {
      const entry = records[index];
      if (!entry) return finish();
      if (!entry.record) { state.unavailablePackages.add(entry.ref); return holdPackages(index + 1); }
      try {
        return await withAuthorizedCapabilityPackageResource({ userId: initial.actor.userId, workspaceId: initial.actor.workspaceId }, entry.record.storage, 'use', undefined,
          async (authorization, held) => {
            if (!authorization.access.canRead || authorization.record.metadata.resourceRef !== entry.ref) state.unavailablePackages.add(entry.ref);
            else for (const pin of pins.filter(value => value.resourceRef === entry.ref)) {
              const published = await getCapabilityPackagePublishedRevision(entry.ref, pin.revisionRef, held);
              if (published?.checksum === pin.checksum) state.validPins.add(pinKey(pin)); else state.unavailablePackages.add(entry.ref);
            }
            return holdPackages(index + 1);
          }, { database });
      } catch (error) {
        if (!isCapabilityPackageError(error) && !(error instanceof CapabilityResourceError)) throw error;
        state.unavailablePackages.add(entry.ref); return holdPackages(index + 1);
      }
    };
    const result = await holdPackages(0);
    await database.run('COMMIT'); return result;
  } catch (error) { await Promise.resolve(database.run('ROLLBACK')).catch(() => undefined); throw error; }
  finally { await database.close(); }
}
async function management(current: Manager): Promise<AgentWorkflowManagementOptions> {
  const packages: AgentWorkflowPackageConfiguration[] = [];
  const unavailablePackages = new Set<string>(), unavailableConnections = new Set<string>();
  for (const binding of current.snapshot.bindings) {
    const pkg = binding.configuration;
    if (!pkg) continue;
    try { await verifyPin(current, pkg.resourceRef, pkg.publishedRevisionRef, pkg.checksum); }
    catch (error) { if (!unavailable(error)) throw error; unavailablePackages.add(pkg.resourceRef); continue; }
    const declarations: AgentWorkflowPackageConfiguration['declarations'] = [];
    for (const declaration of pkg.declarations) {
      const capabilities: AgentWorkflowPackageConfiguration['declarations'][number]['capabilities'] = [];
      for (const capability of declaration.capabilities) {
        const selection = capability.selection;
        const target = async (choice: { alternativeKey: string; target: StoredAgentWorkflowTarget; toolCap: string[] | null }, choiceId?: string) => {
          const alternative = capability.alternatives.find(value => alternativeKey(value) === choice.alternativeKey);
          if (!alternative) fail('AGENT_WORKFLOW_CORRUPT', 'The configured alternative is unavailable.');
          return publicTarget(current, choice.target, { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef,
            declarationPath: declaration.declarationPath, capabilityId: capability.capabilityId, alternativeKey: choice.alternativeKey,
            ...(choiceId === undefined ? {} : { choiceId }) }, alternative, choice.toolCap);
        };
        try {
          const projected = selection.mode === 'fixed' ? { mode: 'fixed' as const, alternativeKey: selection.alternativeKey,
            toolCap: selection.toolCap && [...selection.toolCap], target: await target(selection) }
            : { mode: 'selectable' as const, allowedChoices: await Promise.all(selection.allowedChoices.map(async choice => ({ choiceId: choice.choiceId,
              alternativeKey: choice.alternativeKey, toolCap: choice.toolCap && [...choice.toolCap], target: await target(choice, choice.choiceId) }))),
              ...(selection.defaultChoiceId === undefined ? {} : { defaultChoiceId: selection.defaultChoiceId }),
              ...(selection.personalPolicy ? { personalPolicy: structuredClone(selection.personalPolicy) } : {}) };
          capabilities.push({ capabilityId: capability.capabilityId, required: capability.required, selection: projected });
        } catch (error) { if (!unavailable(error)) throw error; unavailableConnections.add(JSON.stringify([pkg.resourceRef, declaration.declarationPath, capability.capabilityId])); }
      }
      declarations.push({ declarationPath: declaration.declarationPath, capabilities });
    }
    packages.push({ resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.checksum,
      skillSelection: structuredClone(pkg.skillSelection), ...(pkg.childRelativeRoot === undefined ? {} : { childRelativeRoot: pkg.childRelativeRoot }), declarations });
  }
  for (const binding of current.snapshot.bindings) {
    const pkg = binding.configuration;
    if (!pkg) continue;
    try { await verifyPin(current, pkg.resourceRef, pkg.publishedRevisionRef, pkg.checksum); }
    catch (error) { if (!unavailable(error)) throw error; unavailablePackages.add(pkg.resourceRef); continue; }
    for (const declaration of pkg.declarations) for (const capability of declaration.capabilities) {
      try {
        const choices = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
        for (const choice of choices) {
          const alternative = capability.alternatives.find(value => alternativeKey(value) === choice.alternativeKey);
          if (!alternative) fail('AGENT_WORKFLOW_CORRUPT', 'The configured alternative is unavailable.');
          await publicTarget(current, choice.target, { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef,
            declarationPath: declaration.declarationPath, capabilityId: capability.capabilityId, alternativeKey: choice.alternativeKey,
            ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}) }, alternative, choice.toolCap);
        }
      } catch (error) { if (!unavailable(error)) throw error; unavailableConnections.add(JSON.stringify([pkg.resourceRef, declaration.declarationPath, capability.capabilityId])); }
    }
  }
  await finalManager(current);
  const pins = current.snapshot.bindings.flatMap(binding => binding.configuration ? [{ resourceRef: binding.configuration.resourceRef,
    revisionRef: binding.configuration.publishedRevisionRef, checksum: binding.configuration.checksum }] : []);
  return finalReadLease<AgentWorkflowManagementOptions>(current, pins, configuredReadTargets(current), state => {
    for (const ref of state.unavailablePackages) unavailablePackages.add(ref);
    for (const key of state.unavailableTargets) unavailableConnections.add(key);
    const unavailablePackageCount = unavailablePackages.size, unavailableConnectionCount = unavailableConnections.size;
    const blocked = unavailablePackageCount > 0 || unavailableConnectionCount > 0;
    const fresh = state.current;
    const bindingSummaries: AgentWorkflowManagementBindingSummary[] = blocked ? [] : fresh.snapshot.bindings.flatMap(binding => {
      const pkg = binding.configuration;
      if (!pkg) return [];
      return pkg.declarations.flatMap(declaration => declaration.capabilities.flatMap(capability => {
        const choices = capability.selection.mode === 'fixed' ? [capability.selection] : capability.selection.allowedChoices;
        return choices.map(choice => {
          const target = choice.target;
          const connection = target.kind === 'shared' ? state.connections.get(target.connectionRef) : undefined;
          return { resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef,
            declarationPath: declaration.declarationPath, capabilityId: capability.capabilityId, alternativeKey: choice.alternativeKey,
            ...('choiceId' in choice ? { choiceId: choice.choiceId } : {}), source: target.source,
            label: connection ? label(connection.resource.displayName, 'Shared connection')
              : target.source === 'mcp' ? 'Personal MCP connection' : 'Personal Composio connection',
            scopeLabel: connection ? connection.resource.ownership.type === 'team' ? 'team' as const : 'organization' as const : 'personal' as const,
            status: connection?.backend.source === 'composio' && connection.backend.accountBinding === 'pending' ? 'setup_required' as const : 'unknown' as const };
        });
      }));
    });
    return { ...header(fresh), view: 'management', access: { ...fresh.snapshot.access }, profile: {
      agentId: fresh.snapshot.agent.agentId, name: label(fresh.snapshot.agent.name, 'Agent'), iconId: fresh.snapshot.agent.iconId,
      scopeType: fresh.snapshot.agent.scopeType, enabledTools: fresh.snapshot.agent.enabledTools && [...fresh.snapshot.agent.enabledTools] },
      workflowVersion: fresh.snapshot.workflowVersion, configurationState: fresh.snapshot.workflowVersion === null ? 'legacy' : blocked ? 'blocked' : 'available',
      configuration: fresh.snapshot.workflowVersion !== null && !blocked ? parseAgentWorkflowConfiguration({ version: 1, packages }) : null,
      unavailablePackageCount, unavailableConnectionCount, bindingSummaries };
  });
}
function paginate<T>(items: T[], request: { q?: string; page: number; limit: number }) {
  return { items: items.slice((request.page - 1) * request.limit, request.page * request.limit), pagination: { page: request.page, limit: request.limit,
    totalItems: items.length, totalPages: Math.ceil(items.length / request.limit) } };
}
async function packageOptions(current: Manager, request: Extract<AgentWorkflowManagementRequest, { view: 'packages' }>): Promise<AgentWorkflowManagementOptions> {
  const resources = await listCapabilityResources({ userId: current.actor.userId, workspaceId: current.actor.workspaceId });
  const candidates = resources.filter(value => packageAllowed(value, current) && (!request.kind || value.artifact.resourceType === request.kind)
    && (!request.q || `${value.artifact.name}\n${value.metadata.displayName || ''}`.toLowerCase().includes(request.q.toLowerCase())));
  const packages: AgentWorkflowPackageOption[] = [];
  for (const resource of candidates) {
    try {
      const published = await versions(current, resource.metadata.resourceRef);
      if (!published.length) continue;
      await packageDescriptor(current, resource.metadata.resourceRef);
      packages.push({ resourceRef: resource.metadata.resourceRef, name: resource.artifact.name, displayName: label(resource.metadata.displayName || resource.artifact.name, 'Package'),
        kind: resource.artifact.resourceType as 'plugin' | 'skill', scopeLabel: resource.metadata.ownership.type === 'user' ? 'personal' : resource.metadata.ownership.type,
        versions: published.map(value => ({ revisionRef: value.revisionRef, version: value.version, checksum: value.checksum, publishedAt: value.publishedAt })) });
    } catch (error) { if (!unavailable(error)) throw error; }
  }
  for (let index = packages.length - 1; index >= 0; index--) {
    try {
      const currentVersions = await versions(current, packages[index].resourceRef);
      packages[index].versions = packages[index].versions.filter(value => currentVersions.some(selected => selected.revisionRef === value.revisionRef
        && selected.checksum === value.checksum && selected.version === value.version));
      if (!packages[index].versions.length) packages.splice(index, 1);
    } catch (error) { if (!unavailable(error)) throw error; packages.splice(index, 1); }
  }
  await finalManager(current);
  const fresh = await listCapabilityResources({ userId: current.actor.userId, workspaceId: current.actor.workspaceId });
  const permitted = new Map(fresh.filter(value => packageAllowed(value, current)).map(value => [value.metadata.resourceRef, value]));
  for (const pkg of packages) {
    const resource = permitted.get(pkg.resourceRef);
    if (resource) pkg.displayName = label(resource.metadata.displayName || resource.artifact.name, 'Package');
  }
  const selected = packages.filter(value => permitted.has(value.resourceRef));
  return finalReadLease<AgentWorkflowManagementOptions>(current, selected.flatMap(pkg => pkg.versions.map(version => ({ resourceRef: pkg.resourceRef,
    revisionRef: version.revisionRef, checksum: version.checksum }))), [], state => {
    const allowed = selected.filter(pkg => !state.unavailablePackages.has(pkg.resourceRef)).map(pkg => ({ ...pkg,
      versions: pkg.versions.filter(version => state.validPins.has(pinKey({ resourceRef: pkg.resourceRef, revisionRef: version.revisionRef, checksum: version.checksum }))) }));
    const page = paginate(allowed.filter(pkg => pkg.versions.length).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.resourceRef.localeCompare(b.resourceRef)), request);
    return { ...header(state.current), view: 'packages', packages: page.items, pagination: page.pagination };
  });
}
async function connectionOptions(current: Manager, request: Extract<AgentWorkflowManagementRequest, { view: 'connections' }>): Promise<AgentWorkflowManagementOptions> {
  const alternative = await declaredAlternative(current, request), database = await openDb();
  let refs: string[];
  try {
    const verified = await resolveVerifiedAgentActorContextOnConnection(current.actor, database);
    const rows = await database.all(`SELECT connection_ref FROM integration_connection_resources WHERE organization_id=$1 AND source=$2 AND status='active' ORDER BY connection_ref`,
      [verified.organizationId, alternative.source]) as Array<{ connection_ref: string }>;
    if (rows.length > 128) fail('AGENT_WORKFLOW_OPTIONS_UNAVAILABLE', 'Too many shared connections are available for this chooser.', 503);
    refs = rows.map(row => row.connection_ref);
  } finally { await database.close(); }
  const connections: AgentWorkflowManagementConnection[] = [];
  for (const ref of refs) {
    try {
      const [binding] = await authorizeShared(current, [ref]);
      if (alternative.source === 'mcp' && !binding.canManage || alternative.source === 'composio'
        && (binding.backend.source !== 'composio' || binding.backend.toolkit !== alternative.toolkit)
        || binding.allowedToolNames !== null && (alternative.requiredTools ?? []).some(name => !binding.allowedToolNames!.includes(name))) continue;
      let mappingRequired = false;
      if (alternative.source === 'mcp') {
        const backend = await resolveSharedMcpBackend({ userId: current.actor.userId, workspaceId: current.actor.workspaceId,
          organizationId: current.actor.organizationId }, ref, 'manage');
        const definitions = await listMcpServerDefinitions(binding.resource.ownership.organizationId);
        mappingRequired = !definitions.some(value => value.enabled && value.id === backend.connection.serverDefinitionId);
      }
      const [fresh] = await authorizeShared(current, [ref]);
      if (fresh.resource.bindingRevision !== binding.resource.bindingRevision || fresh.resource.source !== alternative.source
        || alternative.source === 'mcp' && !fresh.canManage) continue;
      const value: AgentWorkflowManagementConnection = { connectionRef: ref, bindingRevision: fresh.resource.bindingRevision, source: fresh.resource.source,
        label: label(fresh.resource.displayName, 'Shared connection'), scopeLabel: fresh.resource.ownership.type === 'team' ? 'team' : 'organization',
        application: fresh.resource.application, allowedToolNames: fresh.allowedToolNames && [...fresh.allowedToolNames],
        status: fresh.backend.source === 'composio' && fresh.backend.accountBinding === 'pending' ? 'setup_required' : 'unknown', mappingRequired };
      if (!request.q || value.label.toLowerCase().includes(request.q.toLowerCase())) connections.push(value);
    } catch (error) { if (!unavailable(error)) throw error; }
  }
  const selectedPin = await verifyPin(current, request.resourceRef, request.publishedRevisionRef);
  let finalConnections: AgentWorkflowManagementConnection[] = [];
  if (connections.length) {
    try {
      const final = await authorizeShared(current, connections.map(value => value.connectionRef));
      finalConnections = connections.flatMap(value => {
        const fresh = final.find(binding => binding.resource.connectionRef === value.connectionRef);
        if (!fresh || fresh.resource.bindingRevision !== value.bindingRevision || alternative.source === 'mcp' && !fresh.canManage
          || alternative.source === 'composio' && (fresh.backend.source !== 'composio' || fresh.backend.toolkit !== alternative.toolkit)
          || fresh.allowedToolNames !== null && (alternative.requiredTools ?? []).some(name => !fresh.allowedToolNames!.includes(name))) return [];
        return [{ ...value, label: label(fresh.resource.displayName, 'Shared connection'), allowedToolNames: fresh.allowedToolNames && [...fresh.allowedToolNames],
          status: fresh.backend.source === 'composio' && fresh.backend.accountBinding === 'pending' ? 'setup_required' as const : 'unknown' as const }];
      });
    } catch (error) { if (!unavailable(error)) throw error; await finalManager(current); }
  } else await finalManager(current);
  const checks: ReadTarget[] = finalConnections.map(value => ({ key: value.connectionRef, target: { kind: 'shared', source: value.source,
    connectionRef: value.connectionRef, bindingRevision: value.bindingRevision }, alternative, toolCap: null }));
  return finalReadLease<AgentWorkflowManagementOptions>(current, [{ resourceRef: request.resourceRef,
    revisionRef: request.publishedRevisionRef, checksum: selectedPin.checksum }], checks, state => {
    if (state.unavailablePackages.size) fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is unavailable for this agent.', 403);
    const freshConnections = finalConnections.filter(value => !state.unavailableTargets.has(value.connectionRef)).map(value => {
      const binding = state.connections.get(value.connectionRef)!;
      return { ...value, label: label(binding.resource.displayName, 'Shared connection'), allowedToolNames: binding.allowedToolNames && [...binding.allowedToolNames],
        status: binding.backend.source === 'composio' && binding.backend.accountBinding === 'pending' ? 'setup_required' as const : 'unknown' as const };
    });
    const page = paginate(freshConnections.sort((a, b) => a.label.localeCompare(b.label) || a.connectionRef.localeCompare(b.connectionRef)), request);
    return { ...header(state.current), view: 'connections', connections: page.items, pagination: page.pagination };
  });
}

export async function listAgentWorkflowManagementOptions(actor: AgentManagementActor, value: unknown): Promise<AgentWorkflowManagementOptions> {
  const parsed = agentWorkflowManagementRequestSchema.safeParse(value);
  if (!parsed.success) fail('AGENT_WORKFLOW_INVALID', 'The management request contains invalid or unsupported fields.', 400);
  const request = parsed.data, current = await manager(actor, request.agentId, request.view === 'management' ? undefined : request);
  if (request.view === 'management') return management(current);
  if (request.view === 'packages') return packageOptions(current, request);
  if (request.view === 'package-version') {
    const result = await packageVersion(current, request);
    return finalReadLease<AgentWorkflowManagementOptions>(current, [{ resourceRef: result.resourceRef, revisionRef: result.publishedRevisionRef, checksum: result.checksum }], [], state => {
      if (state.unavailablePackages.size) fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is unavailable for this agent.', 403);
      return { ...result, ...header(state.current) };
    });
  }
  if (request.view === 'connections') return connectionOptions(current, request);
  const alternative = await declaredAlternative(current, request);
  if (request.view === 'personal-connections') {
    if (current.snapshot.agent.scopeType !== 'user' || current.snapshot.agent.ownerUserId !== current.actor.userId) {
      fail('AGENT_WORKFLOW_BINDING_DENIED', 'Only your own personal agent may receive a fixed personal connection.', 403);
    }
    const definitions = alternative.source === 'mcp' && current.organizationId ? await listMcpServerDefinitions(current.organizationId) : [];
    const providers = await enumerateOwnAgentWorkflowProviders({ actor: current.actor, alternatives: [alternative], providerRef: request.providerRef,
      ...(alternative.source === 'mcp' ? { mcpDefinitionMappings: [{ connector: alternative.connector, serverDefinitionIds: definitions.filter(value => value.enabled).map(value => value.id) }] } : {}) });
    const selected = await verifyPin(current, request.resourceRef, request.publishedRevisionRef);
    await finalManager(current); await providers.revalidate();
    return finalReadLease<AgentWorkflowManagementOptions>(current, [{ resourceRef: request.resourceRef, revisionRef: request.publishedRevisionRef, checksum: selected.checksum }], [], state => {
      if (state.unavailablePackages.size) fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is unavailable for this agent.', 403);
      return { ...header(state.current), view: 'personal-connections', alternatives: providers.alternatives };
    });
  }
  if (alternative.source !== 'mcp') fail('AGENT_WORKFLOW_ALTERNATIVE_INVALID', 'Choose an exact declared MCP alternative.', 400);
  const database = await openDb();
  let organizationId: string | null;
  try { organizationId = (await resolveVerifiedAgentActorContextOnConnection(current.actor, database)).organizationId; }
  finally { await database.close(); }
  const definitions = organizationId ? (await listMcpServerDefinitions(organizationId)).filter(value => value.enabled)
    .map(value => ({ definitionId: value.id, label: label(value.name, 'Approved MCP definition'), connector: alternative.connector })) : [];
  const selected = await verifyPin(current, request.resourceRef, request.publishedRevisionRef);
  return finalReadLease<AgentWorkflowManagementOptions>(current, [{ resourceRef: request.resourceRef, revisionRef: request.publishedRevisionRef, checksum: selected.checksum }], [], state => {
    if (state.unavailablePackages.size) fail('AGENT_WORKFLOW_PACKAGE_DENIED', 'The selected package is unavailable for this agent.', 403);
    return { ...header(state.current), view: 'personal-mcp-definitions', definitions };
  });
}
