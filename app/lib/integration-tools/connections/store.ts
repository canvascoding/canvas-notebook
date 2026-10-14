import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { authority, lockOwnership, lockCapabilityScopeWorkspaceAuthority, matchesCapabilityScopeGrant, validateTarget, listCapabilityScopeTargetsOnConnection, type Authority } from '@/app/lib/capabilities/scope-authority';
import { readStoredAgentWorkspaceOnConnection } from '@/app/lib/pi/session-workspace-context';
import { assertUserSeatAccess } from '@/app/lib/license/seat-limit';
import { getAgentAccessOnConnection } from '@/app/lib/agents/access';
import type { AgentProfile } from '@/app/lib/agents/registry';
import { EMAIL_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { schemaFingerprint } from '../schema';
import { assertSharedIntegrationOwnershipManagement } from './ownership';
import {
  IntegrationConnectionError, type AuthorizedIntegrationConnection, type IntegrationConnectionActor,
  type IntegrationConnectionBackendBinding, type IntegrationConnectionDescriptor, type IntegrationConnectionGrant,
  type IntegrationConnectionGrantInput, type IntegrationConnectionMutation, type IntegrationConnectionOperation,
  type IntegrationConnectionRecord, type IntegrationConnectionResource, type IntegrationConnectionRevisions,
  type SharedIntegrationConnectionCreation, type SharedIntegrationConnectionOwnership,
  type IntegrationConnectionTargetCatalog, type IntegrationConnectionScopeChoice,
} from './contracts';

type Row = Record<string, unknown>;
type HeldAuthorization = { database: SqlConnection; actor: IntegrationConnectionActor; connectionRef: string };
const authorizationHost = globalThis as typeof globalThis & {
  __canvasSharedConnectionAuthorityV1?: { held: AsyncLocalStorage<HeldAuthorization>; issued: WeakSet<object> };
};
// Next server chunks and dynamic provider imports must share the same private provenance and transaction context.
const authorityState = authorizationHost.__canvasSharedConnectionAuthorityV1 ??= {
  held: new AsyncLocalStorage<HeldAuthorization>(), issued: new WeakSet<object>(),
};
const heldAuthorization = authorityState.held;
const issuedAuthorizations = authorityState.issued;
const NO_ACCESS = { canRead: false, canUse: false, canManage: false };

export type IntegrationConnectionBindingActor = IntegrationConnectionActor & { projectId?: string | null };
export type IntegrationConnectionBindingBatch = { readonly connectionRefs: readonly string[] };
export type IntegrationConnectionBindingAuthorization = IntegrationConnectionRecord & {
  actor: IntegrationConnectionActor; canUse: boolean; canManage: boolean; allowedToolNames: readonly string[] | null; authorizationRevision: string;
};
type BindingBatchState = { database: SqlConnection; actor: IntegrationConnectionBindingActor; entries: IntegrationConnectionRecord[];
  transactionId: string };
const batchHost = globalThis as typeof globalThis & { __canvasConnectionBindingBatchesV1?: WeakMap<object, BindingBatchState> };
const bindingBatches = batchHost.__canvasConnectionBindingBatchesV1 ??= new WeakMap<object, BindingBatchState>();

export type HeldEmailV2BindingConfiguration = Readonly<{ kind: 'held_email_v2_binding_configuration' }>;
type EmailV2BindingConfiguration = { database: SqlConnection; batch: IntegrationConnectionBindingBatch;
  agentId: string; revision: number; actorKey: string; organizationId: string; transactionId: string };
const emailHost = globalThis as typeof globalThis & {
  __canvasEmailV2BindingConfigurationsV1?: WeakMap<object, EmailV2BindingConfiguration>;
};
const emailConfigurations = emailHost.__canvasEmailV2BindingConfigurationsV1 ??= new WeakMap<object, EmailV2BindingConfiguration>();

async function actualEmailTarget(database: SqlConnection, agent: AgentProfile): Promise<Row | null> {
  if (agent.agentId !== EMAIL_MANAGED_AGENT_ID) return null;
  const row = await database.get(`SELECT agent_id,type,scope_type,organization_id,owner_user_id,revision,workflow_version,workflow_revision
    FROM agents WHERE agent_id=$1`, [EMAIL_MANAGED_AGENT_ID]) as Row | undefined;
  if (!row || row.type !== 'special' || row.scope_type !== 'system' || row.owner_user_id !== null
    || agent.type !== 'special' || agent.scopeType !== 'system' || agent.ownerUserId !== null
    || agent.organizationId !== row.organization_id || agent.revision !== Number(row.revision)) {
    fail('CONNECTION_ACCESS_DENIED', 'The actual email system target changed.', 403);
  }
  return row;
}

/** Private migration intent: only an explicit V2 writer calls this while its real target and source batch are held. */
export async function prepareEmailV2BindingConfigurationOnConnection(database: SqlConnection, batch: IntegrationConnectionBindingBatch,
  agent: AgentProfile): Promise<HeldEmailV2BindingConfiguration> {
  const held = bindingBatches.get(batch);
  if (!held || held.database !== database) fail('CONNECTION_ACCESS_DENIED', 'A current binding transaction is required.', 403);
  const transactionId = String((await database.get('SELECT txid_current()::text AS transaction_id') as Row | undefined)?.transaction_id ?? '');
  if (!transactionId || transactionId !== held.transactionId) fail('CONNECTION_ACCESS_DENIED', 'The binding transaction is no longer held.', 403);
  const row = await actualEmailTarget(database, agent);
  const actor = await resolveVerifiedAgentActorContextOnConnection(held.actor, database, { lock: true });
  if (!row || !actor.organizationId || !['owner', 'admin'].includes(actor.organizationRole ?? '')
    || row.organization_id !== null && row.organization_id !== actor.organizationId) {
    fail('CONNECTION_ACCESS_DENIED', 'Current organization administration is required for this V2 email configuration.', 403);
  }
  const handle = Object.freeze({ kind: 'held_email_v2_binding_configuration' as const });
  emailConfigurations.set(handle, { database, batch, agentId: agent.agentId, revision: agent.revision,
    actorKey: JSON.stringify(held.actor), organizationId: actor.organizationId, transactionId });
  return handle;
}

/** Caller owns BEGIN/COMMIT. Lock connection rows before taking any Agent FOR UPDATE lock. */
export async function lockIntegrationConnectionBindingsOnConnection(database: SqlConnection, input: IntegrationConnectionBindingActor,
  references: readonly string[]): Promise<IntegrationConnectionBindingBatch> {
  const actor = { ...actorSnapshot(input), ...(input.projectId == null ? {} : { projectId: text(input.projectId, 'Project') }) };
  if (actor.agentId || actor.sessionId || actor.policyRevision) fail('CONNECTION_CONTEXT_CHANGED', 'Configuration authority does not accept a runtime session.', 403);
  const refs = [...new Set(references.map(validateIntegrationConnectionRef))].sort();
  if (refs.length > 128) fail('CONNECTION_REQUEST_INVALID', 'Too many selected connection bindings.');
  const current = await authority(database, actor, true);
  if (!current.valid || !current.contextValid) fail('CONNECTION_ACCESS_DENIED', 'The current connection context is unavailable.', 403);
  const entries: IntegrationConnectionRecord[] = [];
  for (const ref of refs) entries.push(await recordOn(database, ref, true));
  const batch = Object.freeze({ connectionRefs: Object.freeze(refs) });
  const transactionId = String((await database.get('SELECT txid_current()::text AS transaction_id') as Row | undefined)?.transaction_id ?? '');
  bindingBatches.set(batch, { database, actor, entries, transactionId });
  return batch;
}

/** Separate binding purpose; never issues an execution proof or invents a persisted session. */
export async function authorizeIntegrationConnectionBindingsOnConnection(database: SqlConnection, batch: IntegrationConnectionBindingBatch,
  agent: AgentProfile, purpose: 'configure' | 'read',
  options: { emailV2Configuration?: HeldEmailV2BindingConfiguration } = {}): Promise<IntegrationConnectionBindingAuthorization[]> {
  const held = bindingBatches.get(batch);
  if (!held || held.database !== database || !['configure', 'read'].includes(purpose)) fail('CONNECTION_ACCESS_DENIED', 'A current binding transaction is required.', 403);
  const actor = held.actor;
  const email = await actualEmailTarget(database, agent);
  let emailOrganizationId: string | null = null;
  const marker = options.emailV2Configuration;
  if (Object.keys(options).some(key => key !== 'emailV2Configuration')) fail('CONNECTION_ACCESS_DENIED', 'Unsupported binding authority.', 403);
  if (marker !== undefined) {
    const proof = marker && typeof marker === 'object' ? emailConfigurations.get(marker) : undefined;
    if (!proof || purpose !== 'configure' || !email || proof.database !== database || proof.batch !== batch
      || proof.agentId !== agent.agentId || proof.revision !== agent.revision || proof.actorKey !== JSON.stringify(actor)) {
      fail('CONNECTION_ACCESS_DENIED', 'A genuine current V2 configuration is required.', 403);
    }
    const transactionId = String((await database.get('SELECT txid_current()::text AS transaction_id') as Row | undefined)?.transaction_id ?? '');
    if (!transactionId || transactionId !== proof.transactionId || transactionId !== held.transactionId) {
      fail('CONNECTION_ACCESS_DENIED', 'The V2 configuration transaction is no longer held.', 403);
    }
    emailOrganizationId = proof.organizationId;
  }
  const persistedEmailV2 = Boolean(email && email.workflow_version === 2 && Number.isSafeInteger(Number(email.workflow_revision))
    && Number(email.workflow_revision) >= 1);
  if (email && (persistedEmailV2 || marker !== undefined)) {
    const transactionId = String((await database.get('SELECT txid_current()::text AS transaction_id') as Row | undefined)?.transaction_id ?? '');
    if (!transactionId || transactionId !== held.transactionId) {
      fail('CONNECTION_ACCESS_DENIED', 'The V2 email binding transaction is no longer held.', 403);
    }
    const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database, { lock: true });
    if (!verified.organizationId || email.organization_id !== null && email.organization_id !== verified.organizationId
      || purpose === 'configure' && !['owner', 'admin'].includes(verified.organizationRole ?? '')
      || emailOrganizationId !== null && emailOrganizationId !== verified.organizationId) {
      fail('CONNECTION_ACCESS_DENIED', 'The current V2 email target context is unavailable.', 403);
    }
    emailOrganizationId = verified.organizationId;
  }
  const agentAccess = await getAgentAccessOnConnection(database, actor.userId, agent.agentId,
    { organizationId: actor.organizationId, workspaceId: actor.workspaceId, projectId: actor.projectId });
  if (!(purpose === 'configure' ? agentAccess.canEdit : agentAccess.canUse)) fail('CONNECTION_ACCESS_DENIED', 'Agent configuration access is not granted.', 403);
  const result: IntegrationConnectionBindingAuthorization[] = [];
  for (const entry of held.entries) {
    const resource = entry.resource, owner = resource.ownership;
    const grants = await grantsOn(database, resource.connectionRef);
    let current = await authority(database, actor, true);
    await lockCapabilityScopeWorkspaceAuthority(database, current, owner, grants.filter(grant => grant.targetType !== 'agent')
      .map(grant => ({ targetType: grant.targetType as Exclude<IntegrationConnectionGrant['targetType'], 'agent'>, targetId: grant.targetId })));
    await lockOwnership(database, owner, current);
    current = await authority(database, actor, true);
    const membership = current.memberships.get(owner.organizationId);
    const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at LIMIT 1') as Row | undefined;
    const team = owner.type === 'team' ? current.workspaces.get(owner.workspaceId) : null;
    const teamActive = owner.type === 'organization' || Boolean(await database.get("SELECT id FROM canvas_workspaces WHERE id=$1 AND organization_id=$2 AND type='team' AND status='active'", [owner.workspaceId, owner.organizationId]));
    const valid = current.valid && current.contextValid && membership?.status === 'active' && configured?.organization_id === owner.organizationId
      && (!actor.organizationId || actor.organizationId === owner.organizationId) && (!current.requestedWorkspace || current.requestedWorkspace.organizationId === owner.organizationId)
      && teamActive && resource.status === 'active' && (agent.organizationId === owner.organizationId
        || agent.type === 'main' && agent.ownerUserId === null || emailOrganizationId === owner.organizationId);
    const manager = valid && (['owner', 'admin'].includes(membership!.role) || team?.canManage === true);
    const inherited = valid && membership!.role !== 'external' && resource.accessMode === 'inherit' && (owner.type === 'organization' || team?.canRead === true);
    let canUse = Boolean(inherited), canManage = Boolean(manager);
    const bounds: Array<string[] | null> = inherited ? [null] : [];
    for (const grant of valid ? grants : []) {
      const matches = grant.targetType === 'agent' ? grant.targetId === agent.agentId
        : matchesCapabilityScopeGrant(current, owner.organizationId, actor.workspaceId, { targetType: grant.targetType, targetId: grant.targetId });
      if (!matches) continue;
      if (grant.canUse) { canUse = true; bounds.push(grant.allowedToolNames); }
      canManage ||= grant.targetType !== 'agent' && grant.canManage;
    }
    if (!valid || !canUse) fail('CONNECTION_ACCESS_DENIED', 'The selected connection is not granted to this agent and current actor.', 403);
    let allowed: string[] | null = bounds.some(bound => bound === null) ? null : [...new Set(bounds.flatMap(bound => bound ?? []))].sort();
    if (resource.allowedToolNames !== null) allowed = allowed === null ? [...resource.allowedToolNames] : allowed.filter(name => resource.allowedToolNames!.includes(name));
    result.push(Object.freeze({ ...structuredClone(entry), actor: Object.freeze({ ...actor }), canUse, canManage,
      allowedToolNames: allowed ? Object.freeze(allowed) : null, authorizationRevision: schemaFingerprint({ resource, backend: entry.backend, actor, agentId: agent.agentId, allowed }) }));
  }
  return result;
}

function fail(code: string, message: string, status = 400): never { throw new IntegrationConnectionError(code, message, status); }
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail('CONNECTION_REQUEST_INVALID', `${label} is invalid.`);
  return value.trim();
}
export function validateIntegrationConnectionRef(value: unknown): string {
  const ref = text(value, 'Connection reference', 80);
  if (!/^canvas-connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(ref)) fail('CONNECTION_REQUEST_INVALID', 'Use an exact server-issued connection reference.');
  return ref;
}
function object(value: unknown, fields: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) fail('CONNECTION_REQUEST_INVALID', 'The connection request contains unsupported fields.');
  return value as Row;
}
function actorSnapshot(input: IntegrationConnectionActor): IntegrationConnectionActor {
  const actor = structuredClone(input);
  return { userId: text(actor.userId, 'Actor'), workspaceId: actor.workspaceId ? text(actor.workspaceId, 'Workspace') : null,
    organizationId: actor.organizationId ? text(actor.organizationId, 'Organization') : null,
    agentId: actor.agentId ? text(actor.agentId, 'Agent') : null, sessionId: actor.sessionId ? text(actor.sessionId, 'Session') : null,
    ...(actor.policyRevision ? { policyRevision: text(actor.policyRevision, 'Policy revision', 512) } : {}) };
}
function sameActor(left: IntegrationConnectionActor, right: IntegrationConnectionActor): boolean {
  return ['userId', 'workspaceId', 'organizationId', 'agentId', 'sessionId', 'policyRevision'].every(key =>
    (left[key as keyof IntegrationConnectionActor] ?? null) === (right[key as keyof IntegrationConnectionActor] ?? null));
}
function ownershipSnapshot(value: unknown): SharedIntegrationConnectionOwnership {
  const owner = object(value, ['type', 'organizationId', 'workspaceId']);
  const organizationId = text(owner.organizationId, 'Owning organization');
  if (owner.type === 'organization' && !Object.hasOwn(owner, 'workspaceId')) return { type: 'organization', organizationId };
  if (owner.type === 'team') return { type: 'team', organizationId, workspaceId: text(owner.workspaceId, 'Owning team') };
  return fail('CONNECTION_SCOPE_INVALID', 'Choose an explicit organization or team ownership scope.');
}
function toolNames(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000) fail('CONNECTION_REQUEST_INVALID', 'The allowed tool set is invalid.');
  return [...new Set(value.map(name => text(name, 'Tool name', 512)))].sort();
}
function optionalDescription(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) fail('CONNECTION_REQUEST_INVALID', 'Description is invalid.');
  return value.trim();
}
function backendSnapshot(value: unknown): IntegrationConnectionBackendBinding {
  const source = (value as Row | null)?.source;
  const backend = object(value, source === 'mcp' ? ['source', 'connectionId']
    : ['source', 'profileId', 'toolkit', 'mode', 'accountBinding', 'connectedAccountId']);
  if (source === 'mcp') return { source, connectionId: text(backend.connectionId, 'Backend connection') };
  if (source !== 'composio' || !['local', 'managed'].includes(String(backend.mode))
    || !['pending', 'account', 'no_auth'].includes(String(backend.accountBinding))) fail('CONNECTION_BINDING_INVALID', 'The provider binding is invalid.');
  const accountBinding = backend.accountBinding as 'pending' | 'account' | 'no_auth';
  const accountId = backend.connectedAccountId === null ? null : text(backend.connectedAccountId, 'Provider account', 512);
  if ((accountBinding === 'account') !== (accountId !== null)) fail('CONNECTION_BINDING_INVALID', 'Choose one exact account, or a provider-verified authentication-free binding.');
  return { source, profileId: text(backend.profileId, 'Profile'), toolkit: text(backend.toolkit, 'App', 128),
    mode: backend.mode as 'local' | 'managed', accountBinding, connectedAccountId: accountId };
}
function grantsSnapshot(value: unknown): IntegrationConnectionGrantInput[] {
  if (!Array.isArray(value) || value.length > 100) fail('CONNECTION_REQUEST_INVALID', 'The connection grants are invalid.');
  const seen = new Set<string>();
  return value.map(value => {
    const grant = object(value, ['targetType', 'targetId', 'canUse', 'canManage', 'allowedToolNames']);
    if (!['organization', 'role', 'workspace', 'project', 'user', 'agent'].includes(String(grant.targetType))
      || typeof grant.canUse !== 'boolean' || typeof grant.canManage !== 'boolean') fail('CONNECTION_REQUEST_INVALID', 'Grant rights must be explicit booleans.');
    if (grant.targetType === 'agent' && grant.canManage) fail('CONNECTION_REQUEST_INVALID', 'Agent grants permit bounded execution, not connection management.');
    const targetId = text(grant.targetId, 'Grant target'), key = `${grant.targetType}:${targetId}`;
    if (seen.has(key)) fail('CONNECTION_REQUEST_INVALID', 'Duplicate connection grant target.');
    seen.add(key);
    return { targetType: grant.targetType as IntegrationConnectionGrantInput['targetType'], targetId,
      canUse: grant.canUse, canManage: grant.canManage, allowedToolNames: toolNames(grant.allowedToolNames) };
  }).sort((a, b) => `${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`));
}
function revisions(input: IntegrationConnectionRevisions): IntegrationConnectionRevisions {
  const result = { metadataRevision: input.metadataRevision, grantsRevision: input.grantsRevision, bindingRevision: input.bindingRevision };
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 1)) fail('CONNECTION_REVISION_REQUIRED', 'All three current revisions are required.');
  return result;
}
function assertRevisions(entry: IntegrationConnectionRecord, expected: IntegrationConnectionRevisions): void {
  if (['metadataRevision', 'grantsRevision', 'bindingRevision'].some(key => entry.resource[key as keyof IntegrationConnectionRevisions] !== expected[key as keyof IntegrationConnectionRevisions])) {
    fail('CONNECTION_REVISION_CONFLICT', 'This connection changed. Reload its current binding and permissions.', 409);
  }
}
function flag(value: unknown): boolean { return value === true || value === 1 || value === '1'; }
function nullable(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function namesFromRow(value: unknown): string[] | null { return value == null ? null : toolNames(JSON.parse(String(value))); }
function mapRecord(row: Row): IntegrationConnectionRecord {
  const ownership = ownershipSnapshot({ type: row.ownership_type, organizationId: row.organization_id,
    ...(row.ownership_type === 'team' ? { workspaceId: row.team_workspace_id } : {}) });
  const resource: IntegrationConnectionResource = { connectionRef: String(row.connection_ref), source: row.source as IntegrationConnectionResource['source'], ownership,
    displayName: String(row.display_name), description: nullable(row.description), application: nullable(row.backend_toolkit),
    responsibleUserId: nullable(row.responsible_user_id), createdByUserId: nullable(row.created_by_user_id), updatedByUserId: nullable(row.updated_by_user_id),
    metadataRevision: Number(row.metadata_revision), grantsRevision: Number(row.grants_revision), bindingRevision: Number(row.binding_revision),
    allowedToolNames: namesFromRow(row.allowed_tool_names_json), accessMode: row.access_mode as 'restricted' | 'inherit', status: row.status as 'active' | 'archived',
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  const backend = backendSnapshot(row.source === 'mcp' ? { source: 'mcp', connectionId: row.backend_connection_id }
    : { source: 'composio', profileId: row.backend_profile_id, toolkit: row.backend_toolkit, mode: row.backend_mode,
      accountBinding: row.account_binding, connectedAccountId: row.backend_account_id });
  return { resource, backend };
}
function mapGrant(row: Row): IntegrationConnectionGrant {
  return { id: String(row.id), connectionRef: String(row.connection_ref), targetType: row.target_type as IntegrationConnectionGrant['targetType'], targetId: String(row.target_id),
    canUse: flag(row.can_use), canManage: flag(row.can_manage), allowedToolNames: namesFromRow(row.allowed_tool_names_json),
    createdByUserId: nullable(row.created_by_user_id), updatedByUserId: nullable(row.updated_by_user_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
async function recordOn(database: SqlConnection, ref: string, lock = false): Promise<IntegrationConnectionRecord> {
  const row = await database.get(`SELECT * FROM integration_connection_resources WHERE connection_ref=$1${lock ? ' FOR UPDATE' : ''}`, [ref]) as Row | undefined;
  if (!row) fail('CONNECTION_NOT_FOUND', 'This connection is unavailable in the current context.', 404);
  return mapRecord(row);
}
async function grantsOn(database: SqlConnection, ref: string): Promise<IntegrationConnectionGrant[]> {
  return (await database.all('SELECT * FROM integration_connection_grants WHERE connection_ref=$1 ORDER BY target_type,target_id', [ref]) as Row[]).map(mapGrant);
}
async function withDatabase<T>(ref: string | null, actor: IntegrationConnectionActor | null,
  transaction: boolean, operation: (database: SqlConnection) => Promise<T>): Promise<T> {
  const held = heldAuthorization.getStore();
  if (held && ref === held.connectionRef && (!actor || sameActor(actor, held.actor))) return operation(held.database);
  if (held && transaction) fail('CONNECTION_CONTEXT_CHANGED', 'Nested connection publication must retain the same actor and resource.', 409);
  const database = await openDb();
  try {
    if (transaction) await database.run('BEGIN');
    const result = await operation(database);
    if (transaction) await database.run('COMMIT');
    return result;
  } catch (error) {
    if (transaction) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw error;
  } finally { await database.close(); }
}
async function validateBackend(database: SqlConnection, owner: SharedIntegrationConnectionOwnership,
  backend: IntegrationConnectionBackendBinding): Promise<void> {
  if (backend.source !== 'composio') return;
  const profile = await database.get('SELECT * FROM composio_connection_profiles WHERE id=$1 FOR SHARE', [backend.profileId]) as Row | undefined;
  if (!profile || profile.owner_user_id !== null || profile.status !== 'active' || profile.organization_id !== owner.organizationId
    || profile.provider_mode !== backend.mode || (owner.type === 'team'
      ? profile.scope_type !== 'workspace' || profile.workspace_id !== owner.workspaceId
      : profile.scope_type !== 'organization' || profile.workspace_id !== null)) fail('CONNECTION_BINDING_INVALID', 'Choose an active profile owned by this exact connection scope.');
}
async function emailV2GrantTarget(database: SqlConnection, targetId: string, organizationId: string): Promise<boolean> {
  if (targetId !== EMAIL_MANAGED_AGENT_ID) return false;
  const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at LIMIT 1') as Row | undefined;
  if (configured?.organization_id !== organizationId) return false;
  const row = await database.get(`SELECT type,scope_type,organization_id,owner_user_id,workflow_version,workflow_revision
    FROM agents WHERE agent_id=$1`, [EMAIL_MANAGED_AGENT_ID]) as Row | undefined;
  return Boolean(row && row.type === 'special' && row.scope_type === 'system' && row.owner_user_id === null
    && (row.organization_id === null || row.organization_id === organizationId) && row.workflow_version === 2
    && Number.isSafeInteger(Number(row.workflow_revision)) && Number(row.workflow_revision) >= 1);
}
async function validateGrant(database: SqlConnection, owner: SharedIntegrationConnectionOwnership, grant: IntegrationConnectionGrantInput): Promise<void> {
  if (grant.targetType !== 'agent') return validateTarget(database, owner.organizationId, { targetType: grant.targetType, targetId: grant.targetId });
  const row = await database.get('SELECT agent_id,type,scope_type,organization_id,owner_user_id FROM agents WHERE agent_id=$1 FOR SHARE', [grant.targetId]) as Row | undefined;
  if (!row || !(row.scope_type === 'organization' && row.organization_id === owner.organizationId
    || row.type === 'main' && row.owner_user_id === null
    || await emailV2GrantTarget(database, grant.targetId, owner.organizationId))) fail('CONNECTION_TARGET_INVALID', 'Choose a currently eligible shared agent.');
}
async function replaceGrants(database: SqlConnection, ref: string, actorId: string, desired: IntegrationConnectionGrantInput[], now: number): Promise<void> {
  const previous = await grantsOn(database, ref);
  await database.run('DELETE FROM integration_connection_grants WHERE connection_ref=$1', [ref]);
  for (const grant of desired) {
    const old = previous.find(value => value.targetType === grant.targetType && value.targetId === grant.targetId);
    await database.run(`INSERT INTO integration_connection_grants (id,connection_ref,target_type,target_id,target_user_id,target_workspace_id,target_project_id,target_agent_id,
      can_use,can_manage,allowed_tool_names_json,created_by_user_id,updated_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [old?.id ?? `connection-grant:${randomUUID()}`, ref, grant.targetType, grant.targetId, grant.targetType === 'user' ? grant.targetId : null,
      grant.targetType === 'workspace' ? grant.targetId : null, grant.targetType === 'project' ? grant.targetId : null, grant.targetType === 'agent' ? grant.targetId : null,
      Number(grant.canUse), Number(grant.canManage), grant.allowedToolNames === null ? null : JSON.stringify(grant.allowedToolNames), old?.createdByUserId ?? actorId, actorId, old?.createdAt ?? now, now]);
  }
}
async function history(database: SqlConnection, record: IntegrationConnectionRecord, actorId: string, action: string, now: number): Promise<void> {
  const r = record.resource;
  await database.run('INSERT INTO integration_connection_history (id,connection_ref,actor_user_id,action,metadata_revision,grants_revision,binding_revision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(), r.connectionRef, actorId, action, r.metadataRevision, r.grantsRevision, r.bindingRevision, now]);
}
async function runtimeAgentOn(database: SqlConnection, actor: IntegrationConnectionActor, auth: Authority,
  owner: SharedIntegrationConnectionOwnership, lock: boolean): Promise<boolean> {
  if (!actor.agentId && !actor.sessionId) return true;
  if (!actor.agentId || !actor.sessionId || !actor.workspaceId || !actor.policyRevision) return false;
  const session = await database.get(`SELECT agent_id,workspace_id,organization_id FROM pi_sessions
    WHERE session_id=$1 AND user_id=$2 AND archived_at IS NULL${lock ? ' FOR SHARE' : ''}`, [actor.sessionId, actor.userId]) as Row | undefined;
  if (!session || session.agent_id !== actor.agentId || session.workspace_id !== actor.workspaceId || session.organization_id !== owner.organizationId) return false;
  if (lock) {
    await database.get('SELECT agent_id FROM agents WHERE agent_id=$1 FOR SHARE', [actor.agentId]);
    await database.all('SELECT id FROM agent_grants WHERE agent_id=$1 ORDER BY id FOR SHARE', [actor.agentId]);
    await database.all('SELECT user_id FROM agent_members WHERE agent_id=$1 ORDER BY user_id FOR SHARE', [actor.agentId]);
  }
  try {
    const workspace = await readStoredAgentWorkspaceOnConnection(database, {
      userId: actor.userId, sessionId: actor.sessionId, agentId: actor.agentId, workspaceId: actor.workspaceId,
      permissions: ['canRead', 'canRunAgent'],
    });
    return workspace.organizationId === owner.organizationId && workspace.projectId === (auth.requestedWorkspace?.projectId ?? null);
  } catch { return false; }
}
async function authorizeOn(database: SqlConnection, actor: IntegrationConnectionActor, entry: IntegrationConnectionRecord,
  operation: IntegrationConnectionOperation, toolName: string | undefined, lock: boolean): Promise<AuthorizedIntegrationConnection> {
  const { resource } = entry, owner = resource.ownership;
  const grants = await grantsOn(database, resource.connectionRef);
  let current = await authority(database, actor, lock);
  if (lock) {
    await lockCapabilityScopeWorkspaceAuthority(database, current, owner, grants.flatMap(grant =>
      grant.targetType === 'agent' ? [] : [{ targetType: grant.targetType, targetId: grant.targetId }]));
    current = await authority(database, actor, true);
    await lockOwnership(database, owner, current);
  }
  const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1') as Row | undefined;
  const membership = current.memberships.get(owner.organizationId);
  const activeOwner = owner.type === 'organization' || Boolean(await database.get("SELECT id FROM canvas_workspaces WHERE id=$1 AND organization_id=$2 AND type='team' AND status='active'", [owner.workspaceId, owner.organizationId]));
  const valid = current.valid && current.contextValid && membership?.status === 'active' && configured?.organization_id === owner.organizationId
    && (!actor.organizationId || actor.organizationId === owner.organizationId)
    && (!current.requestedWorkspace || current.requestedWorkspace.organizationId === owner.organizationId) && activeOwner;
  const administrator = valid && ['owner', 'admin'].includes(membership!.role);
  const team = owner.type === 'team' ? current.workspaces.get(owner.workspaceId) : null;
  const manager = administrator || valid && owner.type === 'team' && team?.canManage === true;
  const inheritedUse = valid && membership!.role !== 'external' && resource.accessMode === 'inherit'
    && (owner.type === 'organization' || Boolean(team?.canRead));
  let canUse = Boolean(inheritedUse), canManage = Boolean(manager);
  const useBounds: Array<string[] | null> = inheritedUse ? [null] : [];
  const agentValid = valid && await runtimeAgentOn(database, actor, current, owner, lock);
  for (const grant of valid ? grants : []) {
    const matches = grant.targetType === 'agent' ? agentValid && actor.agentId === grant.targetId
      && (grant.targetId !== EMAIL_MANAGED_AGENT_ID || await emailV2GrantTarget(database, grant.targetId, owner.organizationId))
      : matchesCapabilityScopeGrant(current, owner.organizationId, actor.workspaceId, { targetType: grant.targetType, targetId: grant.targetId });
    if (!matches) continue;
    canManage ||= grant.targetType !== 'agent' && grant.canManage;
    if (grant.canUse) { canUse = true; useBounds.push(grant.allowedToolNames); }
  }
  canUse &&= resource.status === 'active' && agentValid;
  let permitted: string[] | null = !canUse ? [] : useBounds.some(value => value === null) ? null : [...new Set(useBounds.flatMap(value => value ?? []))].sort();
  if (resource.allowedToolNames !== null) permitted = permitted === null ? [...resource.allowedToolNames] : permitted.filter(name => resource.allowedToolNames!.includes(name));
  const access = valid ? { canRead: canUse || canManage, canUse, canManage } : { ...NO_ACCESS };
  if (!access.canRead || operation === 'manage' && !access.canManage || operation === 'use' && (!access.canUse || permitted?.length === 0)
    || toolName !== undefined && (!access.canUse || permitted !== null && !permitted.includes(toolName))) {
    fail('CONNECTION_ACCESS_DENIED', 'This connection or action is not granted in the current context.', operation === 'inspect' ? 404 : 403);
  }
  const value: AuthorizedIntegrationConnection = structuredClone({ ...entry, actor, access, operation, allowedToolNames: permitted,
    authorizationRevision: schemaFingerprint({ resource, backend: entry.backend, actor, access, permitted,
      membership: membership ? [membership.role, membership.status] : null, workspace: current.requestedWorkspace,
      team: owner.type === 'team' ? current.workspaces.get(owner.workspaceId) : null }) });
  if (value.resource.allowedToolNames) Object.freeze(value.resource.allowedToolNames);
  if (value.allowedToolNames) Object.freeze(value.allowedToolNames);
  Object.freeze(value.resource.ownership); Object.freeze(value.resource); Object.freeze(value.backend); Object.freeze(value.actor); Object.freeze(value.access); Object.freeze(value);
  issuedAuthorizations.add(value);
  return value;
}
export function isAuthorizedIntegrationConnection(value: unknown): value is AuthorizedIntegrationConnection {
  return Boolean(value && typeof value === 'object' && issuedAuthorizations.has(value));
}

/** Provider files compare their marker with an actual committed binding, not a later status revision. */
export async function getPublishedIntegrationConnectionBindingRevision(previous: AuthorizedIntegrationConnection): Promise<number | null> {
  if (!isAuthorizedIntegrationConnection(previous)) fail('CONNECTION_ACCESS_DENIED', 'A current server-issued connection authorization is required.', 403);
  const current = await revalidateAuthorizedIntegrationConnection(previous);
  return withDatabase(current.resource.connectionRef, current.actor, false, async database => {
    const row = await database.get("SELECT MAX(binding_revision) AS revision FROM integration_connection_history WHERE connection_ref=$1 AND action='bind'", [current.resource.connectionRef]) as Row | undefined;
    if (row?.revision == null) return null;
    const revision = Number(row.revision);
    return Number.isSafeInteger(revision) && revision >= 1 && revision <= current.resource.bindingRevision ? revision : null;
  });
}
export async function getIntegrationConnectionRecord(reference: string): Promise<IntegrationConnectionRecord | null> {
  const ref = validateIntegrationConnectionRef(reference);
  return withDatabase(ref, null, false, async database => {
    const row = await database.get('SELECT * FROM integration_connection_resources WHERE connection_ref=$1', [ref]) as Row | undefined;
    return row ? mapRecord(row) : null;
  });
}
export async function authorizeIntegrationConnection(input: IntegrationConnectionActor, reference: string,
  operation: IntegrationConnectionOperation = 'inspect', requestedToolName?: string): Promise<AuthorizedIntegrationConnection> {
  const actor = actorSnapshot(input), ref = validateIntegrationConnectionRef(reference);
  if (!['inspect', 'use', 'manage'].includes(operation)) fail('CONNECTION_REQUEST_INVALID', 'Invalid connection operation.');
  const toolName = requestedToolName === undefined ? undefined : text(requestedToolName, 'Tool name', 512);
  if (operation === 'use') await assertUserSeatAccess({ userId: actor.userId }).catch(() => fail('CONNECTION_ACCESS_DENIED', 'An active account and seat are required.', 403));
  return withDatabase(ref, actor, false, async database => authorizeOn(database, actor, await recordOn(database, ref), operation, toolName, false));
}
export async function revalidateAuthorizedIntegrationConnection(previous: AuthorizedIntegrationConnection,
  operation?: IntegrationConnectionOperation, toolName?: string): Promise<AuthorizedIntegrationConnection> {
  if (!isAuthorizedIntegrationConnection(previous)) fail('CONNECTION_ACCESS_DENIED', 'A current server-issued connection authorization is required.', 403);
  const current = await authorizeIntegrationConnection(previous.actor, previous.resource.connectionRef, operation ?? previous.operation, toolName);
  if (current.authorizationRevision !== previous.authorizationRevision) fail('CONNECTION_BINDING_CHANGED', 'The connection or its permissions changed. Reload its current binding.', 409);
  return current;
}
export async function withAuthorizedIntegrationConnection<T>(input: IntegrationConnectionActor, reference: string,
  operation: IntegrationConnectionOperation, expected: IntegrationConnectionRevisions | undefined,
  callback: (authorization: AuthorizedIntegrationConnection, database: SqlConnection) => Promise<T>, requestedToolName?: string): Promise<T> {
  const actor = actorSnapshot(input), ref = validateIntegrationConnectionRef(reference), capturedExpected = expected ? revisions(structuredClone(expected)) : null;
  if (!['inspect', 'use', 'manage'].includes(operation)) fail('CONNECTION_REQUEST_INVALID', 'Invalid connection operation.');
  const toolName = requestedToolName === undefined ? undefined : text(requestedToolName, 'Tool name', 512);
  if (operation === 'use') await assertUserSeatAccess({ userId: actor.userId }).catch(() => fail('CONNECTION_ACCESS_DENIED', 'An active account and seat are required.', 403));
  return withDatabase(ref, actor, true, async database => {
    const entry = await recordOn(database, ref, true);
    const auth = await authorizeOn(database, actor, entry, operation, toolName, true);
    if (capturedExpected) assertRevisions(entry, capturedExpected);
    return heldAuthorization.run({ database, actor, connectionRef: ref }, () => callback(auth, database));
  });
}
async function descriptorOn(database: SqlConnection, auth: AuthorizedIntegrationConnection): Promise<IntegrationConnectionDescriptor> {
  return { resource: auth.resource, access: auth.access, ...(await ownershipLabelOn(database, auth.resource)),
    ...(auth.access.canManage ? { grants: await grantsOn(database, auth.resource.connectionRef) } : {}) };
}
async function ownershipLabelOn(database: SqlConnection, resource: IntegrationConnectionResource): Promise<{ ownershipLabel?: string }> {
  if (resource.ownership.type !== 'team') return {};
  const row = await database.get('SELECT display_name FROM canvas_workspaces WHERE id=$1 AND organization_id=$2',
    [resource.ownership.workspaceId, resource.ownership.organizationId]) as Row | undefined;
  return typeof row?.display_name === 'string' ? { ownershipLabel: row.display_name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 200) } : {};
}
export async function inspectSharedIntegrationConnection(input: IntegrationConnectionActor, reference: string): Promise<IntegrationConnectionDescriptor> {
  return withAuthorizedIntegrationConnection(input, reference, 'inspect', undefined,
    (auth, database) => descriptorOn(database, auth));
}
export async function listSharedIntegrationConnections(input: IntegrationConnectionActor,
  source?: 'mcp' | 'composio'): Promise<IntegrationConnectionDescriptor[]> {
  const actor = actorSnapshot(input);
  return withDatabase(null, actor, false, async database => {
    const rows = await database.all(`SELECT r.* FROM integration_connection_resources r JOIN organization_user_permissions p
      ON p.organization_id=r.organization_id AND p.user_id=$1 AND p.status='active'${source ? ' WHERE r.source=$2' : ''} ORDER BY r.display_name,r.connection_ref`, [actor.userId, ...(source ? [source] : [])]) as Row[];
    const result: IntegrationConnectionDescriptor[] = [];
    for (const row of rows) {
      try { const auth = await authorizeOn(database, actor, mapRecord(row), 'inspect', undefined, false); result.push({ resource: auth.resource, access: auth.access, ...(await ownershipLabelOn(database, auth.resource)) }); }
      catch (error) { if (!(error instanceof IntegrationConnectionError && [403, 404].includes(error.status))) throw error; }
    }
    return result;
  });
}
export async function createSharedIntegrationConnection(input: IntegrationConnectionActor, value: SharedIntegrationConnectionCreation): Promise<IntegrationConnectionRecord> {
  const actor = actorSnapshot(input), creation = object(structuredClone(value), ['ownership', 'displayName', 'description', 'responsibleUserId', 'accessMode', 'allowedToolNames', 'grants', 'backend', 'connectionRef']);
  const owner = ownershipSnapshot(creation.ownership), backend = backendSnapshot(creation.backend);
  const ref = creation.connectionRef === undefined ? `canvas-connection:${randomUUID()}` : validateIntegrationConnectionRef(creation.connectionRef);
  const name = text(creation.displayName, 'Display name'), description = creation.description === undefined ? null : optionalDescription(creation.description);
  const responsible = creation.responsibleUserId == null ? null : text(creation.responsibleUserId, 'Responsible person');
  const allowed = creation.allowedToolNames === undefined ? null : toolNames(creation.allowedToolNames), grants = grantsSnapshot(creation.grants ?? []);
  const accessMode = creation.accessMode ?? 'restricted';
  if (!['restricted', 'inherit'].includes(String(accessMode))) fail('CONNECTION_REQUEST_INVALID', 'Invalid connection access mode.');
  return withDatabase(ref, actor, true, async database => {
    await assertSharedIntegrationOwnershipManagement(actor, owner, { database });
    await validateBackend(database, owner, backend);
    for (const grant of grants) await validateGrant(database, owner, grant);
    if (responsible) await validateTarget(database, owner.organizationId, { targetType: 'user', targetId: responsible });
    const now = Date.now();
    await database.run(`INSERT INTO integration_connection_resources (connection_ref,source,ownership_type,organization_id,team_workspace_id,display_name,description,
      responsible_user_id,created_by_user_id,updated_by_user_id,metadata_revision,grants_revision,binding_revision,allowed_tool_names_json,access_mode,status,
      backend_connection_id,backend_profile_id,backend_toolkit,backend_mode,account_binding,backend_account_id,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,1,1,1,$10,$11,'active',$12,$13,$14,$15,$16,$17,$18,$18)`,
    [ref, backend.source, owner.type, owner.organizationId, owner.type === 'team' ? owner.workspaceId : null, name, description, responsible, actor.userId,
      allowed === null ? null : JSON.stringify(allowed), accessMode, backend.source === 'mcp' ? backend.connectionId : null,
      backend.source === 'composio' ? backend.profileId : null, backend.source === 'composio' ? backend.toolkit : null,
      backend.source === 'composio' ? backend.mode : null, backend.source === 'composio' ? backend.accountBinding : null,
      backend.source === 'composio' ? backend.connectedAccountId : null, now]);
    await replaceGrants(database, ref, actor.userId, grants, now);
    const entry = await recordOn(database, ref);
    await history(database, entry, actor.userId, 'create', now);
    return entry;
  });
}
export async function mutateSharedIntegrationConnection(input: IntegrationConnectionActor, reference: string,
  value: IntegrationConnectionMutation): Promise<IntegrationConnectionDescriptor> {
  const actor = actorSnapshot(input), ref = validateIntegrationConnectionRef(reference);
  const mutation = object(structuredClone(value), ['expectedMetadataRevision', 'expectedGrantsRevision', 'expectedBindingRevision', 'metadata', 'grants', 'allowedToolNames', 'accessMode', 'status']);
  const expected = revisions({ metadataRevision: mutation.expectedMetadataRevision as number, grantsRevision: mutation.expectedGrantsRevision as number, bindingRevision: mutation.expectedBindingRevision as number });
  const metadata = mutation.metadata === undefined ? null : object(mutation.metadata, ['displayName', 'description', 'responsibleUserId']);
  const patch = { ...(metadata && Object.hasOwn(metadata, 'displayName') ? { displayName: text(metadata.displayName, 'Display name') } : {}),
    ...(metadata && Object.hasOwn(metadata, 'description') ? { description: optionalDescription(metadata.description) } : {}),
    ...(metadata && Object.hasOwn(metadata, 'responsibleUserId') ? { responsibleUserId: metadata.responsibleUserId === null ? null : text(metadata.responsibleUserId, 'Responsible person') } : {}) };
  const grants = mutation.grants === undefined ? undefined : grantsSnapshot(mutation.grants);
  const allowed = mutation.allowedToolNames === undefined ? undefined : toolNames(mutation.allowedToolNames);
  if (mutation.accessMode !== undefined && !['restricted', 'inherit'].includes(String(mutation.accessMode))
    || mutation.status !== undefined && !['active', 'archived'].includes(String(mutation.status))) fail('CONNECTION_REQUEST_INVALID', 'Invalid connection state.');
  const metadataChanged = Object.keys(patch).length > 0, grantsChanged = grants !== undefined || allowed !== undefined || mutation.accessMode !== undefined, bindingChanged = mutation.status !== undefined;
  if (!metadataChanged && !grantsChanged && !bindingChanged) fail('CONNECTION_REQUEST_INVALID', 'Choose a metadata, grant or state change.');
  return withAuthorizedIntegrationConnection(actor, ref, 'manage', expected, async (auth, database) => {
    const r = auth.resource, now = Date.now();
    for (const grant of grants ?? []) await validateGrant(database, r.ownership, grant);
    if (patch.responsibleUserId) await validateTarget(database, r.ownership.organizationId, { targetType: 'user', targetId: patch.responsibleUserId });
    await database.run(`UPDATE integration_connection_resources SET display_name=$1,description=$2,responsible_user_id=$3,allowed_tool_names_json=$4,access_mode=$5,status=$6,
      metadata_revision=metadata_revision+$7,grants_revision=grants_revision+$8,binding_revision=binding_revision+$9,updated_by_user_id=$10,updated_at=$11 WHERE connection_ref=$12`,
    [patch.displayName ?? r.displayName, patch.description === undefined ? r.description : patch.description, patch.responsibleUserId === undefined ? r.responsibleUserId : patch.responsibleUserId,
      allowed === undefined ? r.allowedToolNames === null ? null : JSON.stringify(r.allowedToolNames) : allowed === null ? null : JSON.stringify(allowed),
      mutation.accessMode ?? r.accessMode, mutation.status ?? r.status, Number(metadataChanged), Number(grantsChanged), Number(bindingChanged), actor.userId, now, ref]);
    if (grants) await replaceGrants(database, ref, actor.userId, grants, now);
    const updated = await recordOn(database, ref);
    await history(database, updated, actor.userId, 'mutate', now);
    // Self-revocation returns committed revisions without redisclosing grants or backend data.
    try { return await descriptorOn(database, await authorizeOn(database, actor, updated, 'inspect', undefined, false)); }
    catch (error) { if (error instanceof IntegrationConnectionError && [403, 404].includes(error.status)) return { resource: updated.resource, access: { ...NO_ACCESS } }; throw error; }
  });
}
export async function publishIntegrationConnectionBinding(input: IntegrationConnectionActor, reference: string,
  expectedInput: IntegrationConnectionRevisions, value: IntegrationConnectionBackendBinding): Promise<IntegrationConnectionRecord> {
  const actor = actorSnapshot(input), ref = validateIntegrationConnectionRef(reference), expected = revisions(structuredClone(expectedInput)), backend = backendSnapshot(structuredClone(value));
  return withAuthorizedIntegrationConnection(actor, ref, 'manage', expected, async (auth, database) => {
    const old = auth.backend;
    if (old.source !== backend.source || old.source === 'mcp' && (backend.source !== 'mcp' || old.connectionId !== backend.connectionId)
      || old.source === 'composio' && (backend.source !== 'composio' || old.profileId !== backend.profileId || old.toolkit !== backend.toolkit || old.mode !== backend.mode)) {
      fail('CONNECTION_BINDING_INVALID', 'Reconnect the same provider binding; a different source or profile requires an explicit new connection.');
    }
    await validateBackend(database, auth.resource.ownership, backend);
    const now = Date.now();
    await database.run('UPDATE integration_connection_resources SET account_binding=$1,backend_account_id=$2,binding_revision=binding_revision+1,updated_by_user_id=$3,updated_at=$4 WHERE connection_ref=$5',
      [backend.source === 'composio' ? backend.accountBinding : null, backend.source === 'composio' ? backend.connectedAccountId : null, actor.userId, now, ref]);
    const updated = await recordOn(database, ref);
    await history(database, updated, actor.userId, 'bind', now);
    return updated;
  });
}

export async function listManageableSharedIntegrationScopes(input: IntegrationConnectionActor): Promise<IntegrationConnectionScopeChoice[]> {
  const actor = actorSnapshot(input);
  return withDatabase(null, actor, false, async database => {
    const current = await authority(database, actor);
    const configured = await database.get('SELECT organization_id FROM canvas_organization_settings ORDER BY created_at ASC LIMIT 1') as Row | undefined;
    const organizationId = configured && String(configured.organization_id), membership = organizationId && current.memberships.get(organizationId);
    if (!organizationId || !current.valid || !current.contextValid || !membership || membership.status !== 'active'
      || actor.organizationId && actor.organizationId !== organizationId
      || current.requestedWorkspace && current.requestedWorkspace.organizationId !== organizationId) return [];
    const administrator = ['owner', 'admin'].includes(membership.role), choices: IntegrationConnectionScopeChoice[] = [];
    if (administrator) choices.push({ ownership: { type: 'organization', organizationId }, label: null });
    for (const workspace of current.workspaces.values()) {
      if (workspace.organizationId !== organizationId || workspace.type !== 'team' || !administrator && !workspace.canManage) continue;
      const team = await database.get("SELECT display_name FROM canvas_workspaces WHERE id=$1 AND organization_id=$2 AND type='team' AND status='active'", [workspace.id, organizationId]) as Row | undefined;
      if (team) choices.push({ ownership: { type: 'team', organizationId, workspaceId: workspace.id }, label: String(team.display_name) });
    }
    return choices;
  });
}

async function targetsOn(database: SqlConnection, actor: IntegrationConnectionActor, owner: SharedIntegrationConnectionOwnership): Promise<IntegrationConnectionTargetCatalog> {
  const catalog = await listCapabilityScopeTargetsOnConnection(database, owner.organizationId, actor.userId);
  const agents = await database.all(`SELECT agent_id,name FROM agents WHERE (scope_type='organization' AND organization_id=$1)
    OR (type='main' AND owner_user_id IS NULL)
    OR (agent_id=$2 AND type='special' AND scope_type='system' AND owner_user_id IS NULL
      AND (organization_id IS NULL OR organization_id=$1) AND workflow_version=2 AND workflow_revision>=1
      AND $1=(SELECT organization_id FROM canvas_organization_settings ORDER BY created_at LIMIT 1))
    ORDER BY lower(name),agent_id LIMIT 200`, [owner.organizationId, EMAIL_MANAGED_AGENT_ID]) as Row[];
  return { ...catalog, agents: agents.map(row => ({ agentId: String(row.agent_id), name: String(row.name) })) };
}

export async function listSharedIntegrationConnectionTargets(input: IntegrationConnectionActor, connectionRef: string): Promise<IntegrationConnectionTargetCatalog> {
  return withAuthorizedIntegrationConnection(input, connectionRef, 'manage', undefined,
    (auth, database) => targetsOn(database, auth.actor, auth.resource.ownership));
}

export async function listSharedIntegrationSetupTargets(input: IntegrationConnectionActor, value: SharedIntegrationConnectionOwnership): Promise<IntegrationConnectionTargetCatalog> {
  const actor = actorSnapshot(input), owner = ownershipSnapshot(value);
  return withDatabase(null, actor, true, async database => {
    await assertSharedIntegrationOwnershipManagement(actor, owner, { database });
    return targetsOn(database, actor, owner);
  });
}
