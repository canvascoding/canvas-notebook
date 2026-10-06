import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { OrganizationPolicyTargetCatalog } from '@/app/lib/organization/policy-targets';
import {
  CapabilityResourceError,
  type CapabilityResourceAccess,
  type CapabilityResourceAccessEntry,
  type CapabilityResourceActor,
  type CapabilityResourceAdoption,
  type CapabilityResourceGrant,
  type CapabilityResourceGrantInput,
  type CapabilityResourceMetadata,
  type CapabilityResourceMetadataPatch,
  type CapabilityResourceMutation,
  type CapabilityResourceOwnerScope,
  type CapabilityResourceRecord,
  type CapabilityResourceStorageBinding,
} from './contracts';

import { authority, validateTarget, lockOwnership, lockCapabilityScopeWorkspaceAuthority, matchesCapabilityScopeGrant, listCapabilityScopeTargetsOnConnection, type Authority } from '../scope-authority';
import { projectCapabilityPluginChildAccess } from './child-access';
import { CapabilityPackageError, type AuthorizedCapabilityPackageResource, type CapabilityPackageExpectedResourceRevisions,
  type CapabilityPackageOperation } from '../packages/contracts';

const NO_ACCESS: CapabilityResourceAccess = { canRead: false, canUse: false, canEdit: false, canManage: false };
const OWN_ACCESS: CapabilityResourceAccess = { canRead: true, canUse: true, canEdit: true, canManage: true };
const MAX_GRANTS = 200;
type Row = Record<string, unknown>;

function error(code: string, message: string, status = 400): never {
  throw new CapabilityResourceError(code, message, status);
}
function text(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    return error('RESOURCE_INPUT_INVALID', `${label} is invalid.`);
  }
  return value.trim();
}
function nullableText(value: unknown, label: string, max = 500): string | null {
  return value === null ? null : text(value, label, max);
}
function record(value: unknown, keys: readonly string[], label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !keys.includes(key))) {
    return error('RESOURCE_INPUT_INVALID', `${label} contains unsupported fields.`);
  }
  return value as Row;
}
function flag(value: unknown): boolean { return value === true || value === 1 || value === '1'; }
function optionalString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function actorSnapshot(actor: CapabilityResourceActor): CapabilityResourceActor {
  const input = record(actor, ['userId', 'workspaceId'], 'Actor');
  return { userId: text(input.userId, 'Actor user'), workspaceId: input.workspaceId == null ? null : text(input.workspaceId, 'Workspace') };
}
function storageSnapshot(storage: CapabilityResourceStorageBinding): CapabilityResourceStorageBinding {
  const input = record(storage, ['resourceType', 'resourceId', 'scopeType', 'name', 'sourceType', 'organizationId', 'ownerUserId', 'sourcePluginId'], 'Storage binding');
  if (!['skill', 'plugin'].includes(String(input.resourceType)) || !['system', 'organization', 'user'].includes(String(input.scopeType))
    || !['core', 'standalone', 'plugin'].includes(String(input.sourceType))) error('RESOURCE_INPUT_INVALID', 'Storage binding is invalid.');
  const binding: CapabilityResourceStorageBinding = {
    resourceType: input.resourceType as CapabilityResourceStorageBinding['resourceType'],
    resourceId: text(input.resourceId, 'Resource ID'), scopeType: input.scopeType as CapabilityResourceStorageBinding['scopeType'],
    name: text(input.name, 'Artifact name', 200), sourceType: input.sourceType as CapabilityResourceStorageBinding['sourceType'],
    organizationId: input.organizationId == null ? null : text(input.organizationId, 'Organization'),
    ownerUserId: input.ownerUserId == null ? null : text(input.ownerUserId, 'Owner'),
    sourcePluginId: input.sourcePluginId == null ? null : text(input.sourcePluginId, 'Source plugin'),
  };
  if (binding.scopeType === 'organization' ? !binding.organizationId || binding.ownerUserId !== null
    : binding.scopeType === 'user' ? !binding.ownerUserId || binding.organizationId !== null
      : binding.organizationId !== null || binding.ownerUserId !== null) error('RESOURCE_INPUT_INVALID', 'Storage scope is invalid.');
  if (binding.sourceType === 'plugin' && !binding.sourcePluginId) error('RESOURCE_INPUT_INVALID', 'Source plugin is required.');
  return binding;
}
function storageKey(binding: CapabilityResourceStorageBinding): string {
  return createHash('sha256').update(JSON.stringify([binding.resourceType, binding.resourceId, binding.scopeType, binding.name,
    binding.sourceType, binding.organizationId, binding.ownerUserId, binding.sourcePluginId])).digest('hex');
}
function readOnly(binding: CapabilityResourceStorageBinding): boolean {
  return binding.scopeType === 'system' || binding.sourceType === 'core' || binding.resourceType === 'skill' && binding.sourceType === 'plugin';
}
function ownershipSnapshot(value: unknown): CapabilityResourceOwnerScope {
  const type = (value as Row | null)?.type;
  const keys = type === 'user' ? ['type', 'ownerUserId', 'organizationId'] : type === 'team' ? ['type', 'organizationId', 'workspaceId']
    : type === 'organization' ? ['type', 'organizationId'] : ['type'];
  const input = record(value, keys, 'Ownership');
  if (type === 'user') return { type, ownerUserId: text(input.ownerUserId, 'Owner'), organizationId: nullableText(input.organizationId, 'Organization') };
  if (type === 'organization') return { type, organizationId: text(input.organizationId, 'Organization') };
  if (type === 'team') return { type, organizationId: text(input.organizationId, 'Organization'), workspaceId: text(input.workspaceId, 'Team workspace') };
  if (type === 'system') return { type };
  return error('RESOURCE_INPUT_INVALID', 'Ownership is invalid.');
}
function patchSnapshot(value: unknown): CapabilityResourceMetadataPatch {
  const input = record(value, ['displayName', 'description', 'responsibleUserId'], 'Metadata');
  const patch: CapabilityResourceMetadataPatch = {};
  if ('displayName' in input) patch.displayName = input.displayName === null ? null : text(input.displayName, 'Display name', 200);
  if ('description' in input) {
    if (input.description !== null && (typeof input.description !== 'string' || input.description.length > 4096 || input.description.includes('\0'))) {
      error('RESOURCE_INPUT_INVALID', 'Description is invalid.');
    }
    patch.description = input.description === null ? null : String(input.description).trim();
  }
  if ('responsibleUserId' in input) patch.responsibleUserId = nullableText(input.responsibleUserId, 'Responsible user');
  return patch;
}
function grantsSnapshot(value: unknown): CapabilityResourceGrantInput[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS) error('RESOURCE_INPUT_INVALID', 'The grant list is invalid.');
  const seen = new Set<string>();
  return value.map((grant) => {
    const input = record(grant, ['targetType', 'targetId', 'canUse', 'canEdit', 'canManage'], 'Grant');
    if (!['organization', 'role', 'workspace', 'project', 'user'].includes(String(input.targetType))
      || ['canUse', 'canEdit', 'canManage'].some((key) => typeof input[key] !== 'boolean')) error('RESOURCE_INPUT_INVALID', 'Grant flags must be explicit booleans.');
    const result: CapabilityResourceGrantInput = { targetType: input.targetType as CapabilityResourceGrantInput['targetType'],
      targetId: text(input.targetId, 'Grant target', 200), canUse: input.canUse as boolean, canEdit: input.canEdit as boolean, canManage: input.canManage as boolean };
    const key = JSON.stringify([result.targetType, result.targetId]);
    if (seen.has(key)) error('RESOURCE_INPUT_INVALID', 'Duplicate grant target.');
    seen.add(key);
    return result;
  }).sort((left, right) => JSON.stringify([left.targetType, left.targetId]).localeCompare(JSON.stringify([right.targetType, right.targetId])));
}
function mutationSnapshot(value: CapabilityResourceMutation | CapabilityResourceAdoption, adoption = false): CapabilityResourceAdoption {
  const input = record(value, ['expectedMetadataRevision', 'expectedGrantsRevision', 'metadata', 'grants', 'accessMode', ...(adoption ? ['ownership'] : [])], 'Mutation');
  for (const key of ['expectedMetadataRevision', 'expectedGrantsRevision']) {
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < (adoption ? 0 : 1)) error('RESOURCE_REVISION_REQUIRED', 'Both resource revisions are required.');
  }
  const mutation: CapabilityResourceAdoption = { expectedMetadataRevision: Number(input.expectedMetadataRevision), expectedGrantsRevision: Number(input.expectedGrantsRevision) };
  if ('metadata' in input) mutation.metadata = patchSnapshot(input.metadata);
  if ('grants' in input) mutation.grants = grantsSnapshot(input.grants);
  if ('accessMode' in input) {
    if (input.accessMode !== 'inherit' && input.accessMode !== 'restricted') error('RESOURCE_INPUT_INVALID', 'Access mode is invalid.');
    mutation.accessMode = input.accessMode;
  }
  if (adoption && 'ownership' in input) {
    const ownership = ownershipSnapshot(input.ownership);
    if (ownership.type === 'system') error('RESOURCE_READ_ONLY', 'System resources cannot be adopted.', 403);
    mutation.ownership = ownership;
  }
  return mutation;
}
function mapResource(row: Row): CapabilityResourceRecord {
  const ownership = ownershipSnapshot({ type: row.ownership_type,
    ...(row.ownership_type === 'user' ? { ownerUserId: row.owner_user_id, organizationId: row.organization_id }
      : row.ownership_type === 'team' ? { organizationId: row.organization_id, workspaceId: row.team_workspace_id }
        : row.ownership_type === 'organization' ? { organizationId: row.organization_id } : {}) });
  return {
    metadata: { resourceRef: String(row.resource_ref), legacyResourceId: String(row.legacy_resource_id), resourceType: row.resource_type as CapabilityResourceMetadata['resourceType'],
      sourceType: row.source_type as CapabilityResourceMetadata['sourceType'], sourcePluginId: optionalString(row.source_plugin_id), ownership,
      displayName: optionalString(row.display_name), description: optionalString(row.description), responsibleUserId: optionalString(row.responsible_user_id),
      createdByUserId: optionalString(row.created_by_user_id), updatedByUserId: optionalString(row.updated_by_user_id),
      metadataRevision: Number(row.metadata_revision), grantsRevision: Number(row.grants_revision), accessMode: row.access_mode as CapabilityResourceMetadata['accessMode'],
      status: row.status as CapabilityResourceMetadata['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) },
    storage: { resourceType: row.resource_type as CapabilityResourceStorageBinding['resourceType'], resourceId: String(row.legacy_resource_id), scopeType: row.storage_scope_type as CapabilityResourceStorageBinding['scopeType'],
      name: String(row.artifact_name), sourceType: row.source_type as CapabilityResourceStorageBinding['sourceType'], organizationId: optionalString(row.storage_organization_id),
      ownerUserId: optionalString(row.storage_owner_user_id), sourcePluginId: optionalString(row.source_plugin_id) },
  };
}
function baseline(storage: CapabilityResourceStorageBinding): CapabilityResourceMetadata {
  return { resourceRef: storage.resourceId, legacyResourceId: storage.resourceId, resourceType: storage.resourceType, sourceType: storage.sourceType,
    sourcePluginId: storage.sourcePluginId, ownership: storage.scopeType === 'user' ? { type: 'user', ownerUserId: storage.ownerUserId!, organizationId: null }
      : storage.scopeType === 'organization' ? { type: 'organization', organizationId: storage.organizationId! } : { type: 'system' },
    displayName: null, description: null, responsibleUserId: null, createdByUserId: null, updatedByUserId: null,
    metadataRevision: 0, grantsRevision: 0, accessMode: 'inherit', status: 'active', createdAt: null, updatedAt: null };
}
async function connection<T>(operation: (database: SqlConnection) => Promise<T>, transaction = false): Promise<T> {
  const database = await openDb();
  try {
    if (transaction) await database.run('BEGIN');
    const result = await operation(database);
    if (transaction) await database.run('COMMIT');
    return result;
  } catch (failure) {
    if (transaction) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw failure;
  } finally { await database.close(); }
}
async function findOnConnection(database: SqlConnection, ref: string, lock = false): Promise<CapabilityResourceRecord | null> {
  const rows = await database.all(`SELECT * FROM capability_resources WHERE resource_ref = $1 OR legacy_resource_id = $1${lock ? ' FOR UPDATE' : ''}`, [ref]) as Row[];
  if (rows.length > 1) error('RESOURCE_BINDING_CONFLICT', 'Resource reference is ambiguous.', 409);
  return rows[0] ? mapResource(rows[0]) : null;
}
async function findStorage(database: SqlConnection, storage: CapabilityResourceStorageBinding, lock = false): Promise<CapabilityResourceRecord | null> {
  const found = await findOnConnection(database, storage.resourceId, lock);
  if (found && storageKey(found.storage) !== storageKey(storage)) error('RESOURCE_BINDING_CONFLICT', 'Resource storage binding changed.', 409);
  return found;
}
function orgOf(ownership: CapabilityResourceOwnerScope): string | null { return ownership.type === 'system' ? null : ownership.organizationId; }
function admin(authority: Authority, organizationId: string | null): boolean {
  const membership = organizationId ? authority.memberships.get(organizationId) : null;
  return Boolean(membership?.status === 'active' && ['owner', 'admin'].includes(membership.role) && membership.canShare);
}
function mapGrant(row: Row): CapabilityResourceGrant {
  return { id: String(row.id), resourceRef: String(row.resource_ref), targetType: row.target_type as CapabilityResourceGrant['targetType'], targetId: String(row.target_id),
    canUse: flag(row.can_use), canEdit: flag(row.can_edit), canManage: flag(row.can_manage), createdByUserId: optionalString(row.created_by_user_id),
    updatedByUserId: optionalString(row.updated_by_user_id), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
async function grantsOnConnection(database: SqlConnection, ref: string): Promise<CapabilityResourceGrant[]> {
  return (await database.all('SELECT * FROM capability_resource_grants WHERE resource_ref = $1 ORDER BY target_type, target_id', [ref]) as Row[]).map(mapGrant);
}
async function accessOnConnection(database: SqlConnection, actor: CapabilityResourceActor, entry: CapabilityResourceRecord, current?: Authority): Promise<CapabilityResourceAccess> {
  const auth = current ?? await authority(database, actor);
  const { metadata, storage } = entry;
  if (!auth.valid || !auth.contextValid || metadata.status !== 'active') return { ...NO_ACCESS };
  const organizationId = orgOf(metadata.ownership);
  const membership = organizationId ? auth.memberships.get(organizationId) : null;
  if (organizationId && membership?.status !== 'active' || organizationId && auth.requestedWorkspace && auth.requestedWorkspace.organizationId !== organizationId) return { ...NO_ACCESS };
  if (metadata.ownership.type === 'user') {
    const owner = await database.get(`SELECT u.id FROM "user" u WHERE u.id=$1 AND COALESCE(u.banned,0)=0
      AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM organization_user_permissions p WHERE p.user_id=u.id AND p.organization_id=$2 AND p.status='active'))`,
    [metadata.ownership.ownerUserId, organizationId]);
    if (!owner) return { ...NO_ACCESS };
  }
  if (metadata.ownership.type === 'system') {
    const configured = await database.get('SELECT organization_id FROM canvas_organization_settings LIMIT 1');
    return configured && ![...auth.memberships.values()].some((value) => value.status === 'active') ? { ...NO_ACCESS }
      : { canRead: true, canUse: true, canEdit: false, canManage: false };
  }
  if (metadata.ownership.type === 'user' && metadata.ownership.ownerUserId === actor.userId) {
    return readOnly(storage) ? { canRead: true, canUse: true, canEdit: false, canManage: false } : { ...OWN_ACCESS };
  }
  if (metadata.ownership.type === 'user' && metadata.metadataRevision === 0) return { ...NO_ACCESS };
  const team = metadata.ownership.type === 'team' ? auth.workspaces.get(metadata.ownership.workspaceId) : null;
  if (metadata.ownership.type === 'team') {
    const teamRow = await database.get('SELECT type, organization_id, status FROM canvas_workspaces WHERE id = $1', [metadata.ownership.workspaceId]) as Row | undefined;
    if (!teamRow || teamRow.type !== 'team' || teamRow.status !== 'active' || teamRow.organization_id !== organizationId) return { ...NO_ACCESS };
  }
  const manager = (metadata.ownership.type === 'organization' || metadata.ownership.type === 'team')
    && (admin(auth, organizationId) || Boolean(team?.type === 'team' && team.canManage));
  const inheritedUse = metadata.accessMode === 'inherit' && (metadata.ownership.type === 'organization' ? membership?.status === 'active'
    : metadata.ownership.type === 'team' ? Boolean(team?.canRead) : false);
  const access = { canRead: manager || inheritedUse, canUse: Boolean(inheritedUse), canEdit: manager && !readOnly(storage), canManage: manager && !readOnly(storage) };
  if (metadata.metadataRevision === 0 || !organizationId) return access;
  const grants = await grantsOnConnection(database, metadata.resourceRef);
  for (const grant of grants) {
    const targetMatches = matchesCapabilityScopeGrant(auth, organizationId, actor.workspaceId, grant);
    if (!targetMatches) continue;
    access.canUse ||= grant.canUse;
    access.canEdit ||= grant.canEdit && !readOnly(storage);
    access.canManage ||= grant.canManage && !readOnly(storage);
  }
  access.canRead ||= access.canUse || access.canEdit || access.canManage;
  return access;
}
async function lockActorWorkspaceAuthority(database: SqlConnection, auth: Authority, ownership: CapabilityResourceOwnerScope, resourceRef?: string): Promise<void> {
  await lockCapabilityScopeWorkspaceAuthority(database, auth, ownership, resourceRef ? await grantsOnConnection(database, resourceRef) : []);
}
async function replaceGrants(database: SqlConnection, ref: string, actorUserId: string, desired: CapabilityResourceGrantInput[], now: number): Promise<void> {
  const old = await grantsOnConnection(database, ref);
  await database.run('DELETE FROM capability_resource_grants WHERE resource_ref = $1', [ref]);
  for (const grant of desired) {
    const previous = old.find((value) => value.targetType === grant.targetType && value.targetId === grant.targetId);
    await database.run(`INSERT INTO capability_resource_grants (id, resource_ref, target_type, target_id, target_user_id, target_workspace_id, target_project_id,
      can_use, can_edit, can_manage, created_by_user_id, updated_by_user_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [previous?.id ?? `canvas-grant:${randomUUID()}`, ref, grant.targetType, grant.targetId,
      grant.targetType === 'user' ? grant.targetId : null, grant.targetType === 'workspace' ? grant.targetId : null, grant.targetType === 'project' ? grant.targetId : null,
      Number(grant.canUse), Number(grant.canEdit), Number(grant.canManage), previous?.createdByUserId ?? actorUserId, actorUserId, previous?.createdAt ?? now, now]);
  }
}
async function history(database: SqlConnection, ref: string, actor: CapabilityResourceActor, action: 'adopt' | 'mutate', metadataRevision: number, grantsRevision: number, now: number): Promise<void> {
  await database.run(`INSERT INTO capability_resource_history (id,resource_ref,actor_user_id,action,metadata_revision,grants_revision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), ref, actor.userId, action, metadataRevision, grantsRevision, now]);
}

/** Internal lookup only. Callers must authorize before reading artifact contents. */
export async function findCapabilityResourceRecord(resourceRef: string): Promise<CapabilityResourceRecord | null> {
  const ref = text(resourceRef, 'Resource reference');
  return connection((database) => findOnConnection(database, ref));
}
export async function getCapabilityResourceAccess(actorInput: CapabilityResourceActor, storageInput: CapabilityResourceStorageBinding): Promise<CapabilityResourceAccessEntry> {
  const actor = actorSnapshot(actorInput);
  const storage = storageSnapshot(storageInput);
  return connection(async (database) => {
    const entry = await findStorage(database, storage) ?? { metadata: baseline(storage), storage };
    return { metadata: entry.metadata, access: await accessOnConnection(database, actor, entry) };
  });
}
export async function listCapabilityResourceRecordsForActor(actorInput: CapabilityResourceActor): Promise<CapabilityResourceRecord[]> {
  const actor = actorSnapshot(actorInput);
  return connection(async (database) => {
    const auth = await authority(database, actor);
    if (!auth.valid || !auth.contextValid) return [];
    const rows = await database.all(`SELECT * FROM capability_resources WHERE status = 'active' AND (ownership_type = 'system' OR owner_user_id = $1
      OR organization_id IN (SELECT organization_id FROM organization_user_permissions WHERE user_id = $1 AND status = 'active')) ORDER BY resource_ref`, [actor.userId]) as Row[];
    const visible: CapabilityResourceRecord[] = [];
    for (const row of rows) {
      const entry = mapResource(row);
      if ((await accessOnConnection(database, actor, entry, auth)).canRead) visible.push(entry);
    }
    return visible;
  });
}
export async function adoptCapabilityResource(actorInput: CapabilityResourceActor, storageInput: CapabilityResourceStorageBinding, adoptionInput: CapabilityResourceAdoption): Promise<CapabilityResourceAccessEntry> {
  const actor = actorSnapshot(actorInput);
  const storage = storageSnapshot(storageInput);
  const adoption = mutationSnapshot(adoptionInput, true);
  if (adoption.expectedMetadataRevision !== 0 || adoption.expectedGrantsRevision !== 0) error('RESOURCE_REVISION_CONFLICT', 'Unmanaged resource adoption requires zero revisions.', 409);
  if (readOnly(storage)) error('RESOURCE_READ_ONLY', 'This resource is managed by the system or its parent plugin.', 403);
  // Derive the actual configured organization; never choose an arbitrary membership as a personal sharing domain.
  const configured = storage.scopeType === 'user' && !adoption.ownership ? await readOrganizationPermissionForUser(actor.userId) : null;
  if (configured?.configured && configured.permission?.status !== 'active') error('RESOURCE_ACCESS_DENIED', 'An active configured organization membership is required.', 403);
  const ownership = adoption.ownership ?? (storage.scopeType === 'user'
    ? { type: 'user' as const, ownerUserId: storage.ownerUserId!, organizationId: configured?.permission?.status === 'active' ? configured.organizationId : null }
    : { type: 'organization' as const, organizationId: storage.organizationId! });
  if (storage.scopeType === 'user' ? ownership.type !== 'user' || ownership.ownerUserId !== storage.ownerUserId || ownership.ownerUserId !== actor.userId
    : !['organization', 'team'].includes(ownership.type) || orgOf(ownership) !== storage.organizationId) error('RESOURCE_SCOPE_INVALID', 'Ownership must match the installed storage scope.');
  return connection(async (database) => {
    await database.get('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`capability-resource:${storage.resourceId}`]);
    if (await findStorage(database, storage, true)) error('RESOURCE_REVISION_CONFLICT', 'Resource is already managed.', 409);
    let auth = await authority(database, actor, true);
    await lockActorWorkspaceAuthority(database, auth, ownership);
    auth = await authority(database, actor, true);
    await lockOwnership(database, ownership, auth);
    const entry: CapabilityResourceRecord = { metadata: { ...baseline(storage), ownership }, storage };
    const initialAccess = await accessOnConnection(database, actor, entry, auth);
    if (!initialAccess.canManage) error('RESOURCE_ACCESS_DENIED', 'Resource management permission is required.', 403);
    for (const grant of adoption.grants ?? []) await validateTarget(database, orgOf(ownership), grant);
    if (adoption.metadata?.responsibleUserId) {
      if (orgOf(ownership)) await validateTarget(database, orgOf(ownership), { targetType: 'user', targetId: adoption.metadata.responsibleUserId });
      else if (ownership.type !== 'user' || adoption.metadata.responsibleUserId !== ownership.ownerUserId) error('RESOURCE_TARGET_INVALID', 'Responsible user is outside the resource scope.');
    }
    const ref = `canvas-resource:${randomUUID()}`;
    const now = Date.now();
    await database.run(`INSERT INTO capability_resources (resource_ref,storage_binding_key,legacy_resource_id,resource_type,source_type,source_plugin_id,artifact_name,
      storage_scope_type,storage_organization_id,storage_owner_user_id,ownership_type,organization_id,owner_user_id,team_workspace_id,
      display_name,description,responsible_user_id,created_by_user_id,updated_by_user_id,metadata_revision,grants_revision,access_mode,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,1,1,$19,'active',$20,$20)`,
    [ref, storageKey(storage), storage.resourceId, storage.resourceType, storage.sourceType, storage.sourcePluginId, storage.name,
      storage.scopeType, storage.organizationId, storage.ownerUserId, ownership.type, orgOf(ownership), ownership.type === 'user' ? ownership.ownerUserId : null,
      ownership.type === 'team' ? ownership.workspaceId : null, adoption.metadata?.displayName ?? null, adoption.metadata?.description ?? null,
      adoption.metadata?.responsibleUserId ?? null, actor.userId, adoption.accessMode ?? 'inherit', now]);
    await replaceGrants(database, ref, actor.userId, adoption.grants ?? [], now);
    await history(database, ref, actor, 'adopt', 1, 1, now);
    const adopted = (await findOnConnection(database, ref))!;
    return { metadata: adopted.metadata, access: await accessOnConnection(database, actor, adopted, auth) };
  }, true);
}
export async function mutateCapabilityResource(actorInput: CapabilityResourceActor, resourceRefInput: string, mutationInput: CapabilityResourceMutation): Promise<CapabilityResourceAccessEntry> {
  const actor = actorSnapshot(actorInput);
  const ref = text(resourceRefInput, 'Resource reference');
  const mutation = mutationSnapshot(mutationInput);
  return connection(async (database) => {
    const entry = await findOnConnection(database, ref, true);
    if (!entry) error('RESOURCE_NOT_FOUND', 'Resource was not found.', 404);
    if (readOnly(entry.storage)) error('RESOURCE_READ_ONLY', 'Resource is read only.', 403);
    let auth = await authority(database, actor, true);
    await lockActorWorkspaceAuthority(database, auth, entry.metadata.ownership, entry.metadata.resourceRef);
    auth = await authority(database, actor, true);
    await lockOwnership(database, entry.metadata.ownership, auth);
    const access = await accessOnConnection(database, actor, entry, auth);
    const metadataChanged = Boolean(mutation.metadata && Object.keys(mutation.metadata).length);
    const contentMetadataChanged = Boolean(mutation.metadata && (Object.hasOwn(mutation.metadata, 'displayName') || Object.hasOwn(mutation.metadata, 'description')));
    const responsibleChanged = Boolean(mutation.metadata && Object.hasOwn(mutation.metadata, 'responsibleUserId'));
    const grantsChanged = mutation.grants !== undefined || mutation.accessMode !== undefined;
    if (!access.canRead || contentMetadataChanged && !access.canEdit || (responsibleChanged || grantsChanged) && !access.canManage) error('RESOURCE_ACCESS_DENIED', 'Resource mutation permission is required.', 403);
    if (entry.metadata.metadataRevision !== mutation.expectedMetadataRevision || entry.metadata.grantsRevision !== mutation.expectedGrantsRevision) {
      error('RESOURCE_REVISION_CONFLICT', 'Resource metadata or grants changed. Reload before editing.', 409);
    }
    for (const grant of mutation.grants ?? []) await validateTarget(database, orgOf(entry.metadata.ownership), grant);
    if (mutation.metadata?.responsibleUserId) {
      if (orgOf(entry.metadata.ownership)) await validateTarget(database, orgOf(entry.metadata.ownership), { targetType: 'user', targetId: mutation.metadata.responsibleUserId });
      else if (entry.metadata.ownership.type !== 'user' || mutation.metadata.responsibleUserId !== entry.metadata.ownership.ownerUserId) error('RESOURCE_TARGET_INVALID', 'Responsible user is outside the resource scope.');
    }
    if (!metadataChanged && !grantsChanged) return { metadata: entry.metadata, access };
    const now = Date.now();
    const metadataRevision = entry.metadata.metadataRevision + Number(metadataChanged);
    const grantsRevision = entry.metadata.grantsRevision + Number(grantsChanged);
    const patch = mutation.metadata;
    const changed = await database.run(`UPDATE capability_resources SET display_name=$1,description=$2,responsible_user_id=$3,access_mode=$4,
      metadata_revision=$5,grants_revision=$6,updated_by_user_id=$7,updated_at=$8 WHERE resource_ref=$9 AND metadata_revision=$10 AND grants_revision=$11`,
    [patch?.displayName === undefined ? entry.metadata.displayName : patch.displayName, patch?.description === undefined ? entry.metadata.description : patch.description,
      patch?.responsibleUserId === undefined ? entry.metadata.responsibleUserId : patch.responsibleUserId, mutation.accessMode ?? entry.metadata.accessMode,
      metadataRevision, grantsRevision, actor.userId, now, entry.metadata.resourceRef, mutation.expectedMetadataRevision, mutation.expectedGrantsRevision]);
    if ((changed as { changes?: number }).changes !== 1) error('RESOURCE_REVISION_CONFLICT', 'Resource changed before the mutation completed.', 409);
    if (mutation.grants) await replaceGrants(database, entry.metadata.resourceRef, actor.userId, mutation.grants, now);
    await history(database, entry.metadata.resourceRef, actor, 'mutate', metadataRevision, grantsRevision, now);
    const updated = (await findOnConnection(database, entry.metadata.resourceRef))!;
    return { metadata: updated.metadata, access: await accessOnConnection(database, actor, updated, auth) };
  }, true);
}
export async function listCapabilityResourceGrants(actorInput: CapabilityResourceActor, resourceRefInput: string): Promise<CapabilityResourceGrant[]> {
  const actor = actorSnapshot(actorInput);
  const ref = text(resourceRefInput, 'Resource reference');
  return connection(async (database) => {
    const entry = await findOnConnection(database, ref);
    if (!entry || !(await accessOnConnection(database, actor, entry)).canManage) error('RESOURCE_ACCESS_DENIED', 'Resource management permission is required.', 403);
    return grantsOnConnection(database, entry.metadata.resourceRef);
  });
}
export async function listCapabilityResourceGrantTargets(actorInput: CapabilityResourceActor, resourceRefInput: string, legacyStorageBinding?: CapabilityResourceStorageBinding): Promise<OrganizationPolicyTargetCatalog> {
  const actor = actorSnapshot(actorInput);
  const ref = text(resourceRefInput, 'Resource reference');
  const storage = legacyStorageBinding === undefined ? null : storageSnapshot(legacyStorageBinding);
  const configured = storage?.scopeType === 'user' ? await readOrganizationPermissionForUser(actor.userId) : null;
  return connection(async (database) => {
    const managed = await findOnConnection(database, ref);
    if (!managed && storage && storage.resourceId !== ref) error('RESOURCE_BINDING_CONFLICT', 'Unmanaged target lookup requires the exact legacy reference.', 409);
    const entry = managed ?? (storage ? { metadata: baseline(storage), storage } : null);
    if (entry && storage && storageKey(entry.storage) !== storageKey(storage)) error('RESOURCE_BINDING_CONFLICT', 'Resource storage binding changed.', 409);
    if (!entry || !(await accessOnConnection(database, actor, entry)).canManage) error('RESOURCE_ACCESS_DENIED', 'Resource management permission is required.', 403);
    const organizationId = orgOf(entry.metadata.ownership) ?? (!managed && configured?.permission?.status === 'active' ? configured.organizationId : null);
    if (!organizationId) return { users: [], workspaces: [], projects: [] };
    return listCapabilityScopeTargetsOnConnection(database, organizationId, actor.userId);
  });
}

type PackageAuthorityRegistry = { issued: WeakSet<object>; held: WeakMap<object, SqlConnection> };
const packageAuthorityKey = Symbol.for('canvas.capability.package-authority.v1');
const packageAuthorityGlobal = globalThis as typeof globalThis & { [packageAuthorityKey]?: PackageAuthorityRegistry };
const packageAuthority = packageAuthorityGlobal[packageAuthorityKey] ??= { issued: new WeakSet(), held: new WeakMap() };

export function isAuthorizedCapabilityPackageResource(value: unknown): value is AuthorizedCapabilityPackageResource {
  return Boolean(value && typeof value === 'object' && packageAuthority.issued.has(value));
}

/** A receipt is valid for publication only while its issuing SQL transaction remains held. */
export function isHeldCapabilityPackageResource(value: unknown, database: SqlConnection): value is AuthorizedCapabilityPackageResource {
  return isAuthorizedCapabilityPackageResource(value) && packageAuthority.held.get(value) === database;
}

export type CapabilityPackageAuthorizationOptions = { parentStorage?: CapabilityResourceStorageBinding; database?: SqlConnection };

/** Uses the existing resource authority on the same connection; no second permission service is opened. */
export async function withAuthorizedCapabilityPackageResource<T>(
  actorInput: CapabilityResourceActor,
  storageInput: CapabilityResourceStorageBinding,
  operation: CapabilityPackageOperation,
  expected: CapabilityPackageExpectedResourceRevisions | undefined,
  callback: (authorization: AuthorizedCapabilityPackageResource, database: SqlConnection) => Promise<T>,
  options: CapabilityPackageAuthorizationOptions = {},
): Promise<T> {
  const actor = actorSnapshot(actorInput), storage = storageSnapshot(storageInput);
  if (!['read', 'use', 'edit', 'publish'].includes(operation)) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The package operation is invalid.');
  const parentStorage = options.parentStorage ? storageSnapshot(options.parentStorage) : null;
  if (storage.resourceType === 'skill' && storage.sourceType === 'plugin') {
    if (!parentStorage || parentStorage.resourceType !== 'plugin' || parentStorage.resourceId !== storage.sourcePluginId
      || parentStorage.scopeType !== storage.scopeType || parentStorage.ownerUserId !== storage.ownerUserId
      || parentStorage.organizationId !== storage.organizationId) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The source plugin binding is required.', 403);
    }
  } else if (parentStorage) throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'This package has no source plugin.');
  if (expected && (!Number.isSafeInteger(expected.expectedMetadataRevision) || expected.expectedMetadataRevision < 0
    || !Number.isSafeInteger(expected.expectedGrantsRevision) || expected.expectedGrantsRevision < 0)) {
    throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'Both resource revisions are required.');
  }
  const execute = async (database: SqlConnection): Promise<T> => {
    // Canonical organization/user authority precedes resource locks, as in the shared connection store.
    let auth = await authority(database, actor, true);
    for (const resourceId of [...new Set([storage.resourceId,...(parentStorage ? [parentStorage.resourceId] : [])])].sort()) {
      await database.get('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`capability-resource:${resourceId}`]);
    }
    const parent = parentStorage ? await findStorage(database, parentStorage, true)
      ?? { metadata: baseline(parentStorage), storage: parentStorage } : null;
    const entry = await findStorage(database, storage, true) ?? { metadata: baseline(storage), storage };
    const governed = parent ?? entry;
    await lockActorWorkspaceAuthority(database, auth, governed.metadata.ownership, governed.metadata.metadataRevision ? governed.metadata.resourceRef : undefined);
    await lockOwnership(database, governed.metadata.ownership, auth);
    auth = await authority(database, actor, true);
    const ownAccess = await accessOnConnection(database, actor, entry, auth);
    const projected = parent ? projectCapabilityPluginChildAccess({ metadata: entry.metadata, access: ownAccess },
      { metadata: parent.metadata, access: await accessOnConnection(database, actor, parent, auth) }) : { metadata: entry.metadata, access: ownAccess };
    const allowed = operation === 'read' ? projected.access.canRead : operation === 'use' ? projected.access.canUse : projected.access.canEdit;
    if (!allowed) throw new CapabilityPackageError(readOnly(storage) && ['edit', 'publish'].includes(operation) ? 'PACKAGE_READ_ONLY' : 'PACKAGE_ACCESS_DENIED', 'The package operation is not permitted.', 403);
    if (expected && (projected.metadata.metadataRevision !== expected.expectedMetadataRevision
      || projected.metadata.grantsRevision !== expected.expectedGrantsRevision)) {
      throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'Package metadata or grants changed. Reload before editing.', 409);
    }
    const receipt: AuthorizedCapabilityPackageResource = { actor: Object.freeze({ ...actor }),
      record: Object.freeze({ metadata: Object.freeze({ ...projected.metadata, ownership: Object.freeze({ ...projected.metadata.ownership }) }), storage: Object.freeze({ ...storage }) }),
      access: Object.freeze({ ...projected.access }), operation };
    Object.freeze(receipt); packageAuthority.issued.add(receipt); packageAuthority.held.set(receipt, database);
    try { return await callback(receipt, database); } finally { packageAuthority.held.delete(receipt); }
  };
  return options.database ? execute(options.database) : connection(execute, true);
}

export async function authorizeCapabilityPackageResource(
  actor: CapabilityResourceActor, storage: CapabilityResourceStorageBinding, operation: CapabilityPackageOperation,
  options: CapabilityPackageAuthorizationOptions & { expectedRevisions?: CapabilityPackageExpectedResourceRevisions } = {},
): Promise<AuthorizedCapabilityPackageResource> {
  return withAuthorizedCapabilityPackageResource(actor, storage, operation, options.expectedRevisions, async authorization => authorization, options);
}

/** A new copy requires actual target management; it creates no visible resource until publication. */
export async function withAuthorizedCapabilityPackageTarget<T>(
  actorInput: CapabilityResourceActor, storageInput: CapabilityResourceStorageBinding,
  ownershipInput: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>,
  callback: (authorization: AuthorizedCapabilityPackageResource, database: SqlConnection) => Promise<T>,
  options: {database?:SqlConnection} = {},
): Promise<T> {
  const actor = actorSnapshot(actorInput), storage = storageSnapshot(storageInput), ownership = ownershipSnapshot(ownershipInput);
  if (readOnly(storage) || storage.sourceType !== 'standalone' || ownership.type === 'system'
    || (storage.scopeType === 'user' ? ownership.type !== 'user' || ownership.ownerUserId !== storage.ownerUserId || ownership.ownerUserId !== actor.userId
      : !['organization', 'team'].includes(ownership.type) || orgOf(ownership) !== storage.organizationId)) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The target ownership is not permitted.', 403);
  }
  const execute = async (database:SqlConnection):Promise<T> => {
    let auth = await authority(database, actor, true);
    await database.get('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`capability-resource:${storage.resourceId}`]);
    if (await findStorage(database, storage, true)) throw new CapabilityPackageError('PACKAGE_NAMESPACE_CONFLICT', 'The target resource already exists.', 409);
    await lockActorWorkspaceAuthority(database, auth, ownership);
    await lockOwnership(database, ownership, auth);
    auth = await authority(database, actor, true);
    const entry: CapabilityResourceRecord = { metadata: { ...baseline(storage), ownership, accessMode: 'restricted' }, storage };
    const access = await accessOnConnection(database, actor, entry, auth);
    if (!access.canManage) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Target management permission is required.', 403);
    const receipt: AuthorizedCapabilityPackageResource = Object.freeze({ actor: Object.freeze({ ...actor }),
      record: Object.freeze({ metadata: Object.freeze({ ...entry.metadata, ownership: Object.freeze({ ...ownership }) }), storage: Object.freeze({ ...storage }) }),
      access: Object.freeze({ ...access }), operation: 'publish' });
    packageAuthority.issued.add(receipt); packageAuthority.held.set(receipt, database);
    try { return await callback(receipt, database); } finally { packageAuthority.held.delete(receipt); }
  };
  return options.database ? execute(options.database) : connection(execute,true);
}

export async function authorizeCapabilityPackageTarget(
  actor: CapabilityResourceActor, storage: CapabilityResourceStorageBinding, ownership: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>,
): Promise<AuthorizedCapabilityPackageResource> {
  return withAuthorizedCapabilityPackageTarget(actor, storage, ownership, async authorization => authorization);
}

/** Internal publication primitive. Its receipt and connection must come from the same held transaction. */
export async function createCapabilityPackageTargetOnConnection(
  authorization: AuthorizedCapabilityPackageResource, resourceRef: string, database: SqlConnection,
): Promise<CapabilityResourceRecord> {
  if (!isHeldCapabilityPackageResource(authorization, database) || !authorization.access.canManage
    || authorization.record.metadata.metadataRevision !== 0 || !/^canvas-resource:[0-9a-f-]{36}$/u.test(resourceRef)) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The target publication is not authorized.', 403);
  }
  const { storage, metadata } = authorization.record, ownership = metadata.ownership;
  if (await findStorage(database, storage, true)) throw new CapabilityPackageError('PACKAGE_NAMESPACE_CONFLICT', 'The target resource already exists.', 409);
  const now = Date.now();
  await database.run(`INSERT INTO capability_resources (resource_ref,storage_binding_key,legacy_resource_id,resource_type,source_type,source_plugin_id,artifact_name,
    storage_scope_type,storage_organization_id,storage_owner_user_id,ownership_type,organization_id,owner_user_id,team_workspace_id,
    display_name,description,responsible_user_id,created_by_user_id,updated_by_user_id,metadata_revision,grants_revision,access_mode,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,NULL,NULL,$15,$15,1,1,'restricted','active',$16,$16)`,
  [resourceRef, storageKey(storage), storage.resourceId, storage.resourceType, storage.sourceType, storage.sourcePluginId, storage.name,
    storage.scopeType, storage.organizationId, storage.ownerUserId, ownership.type, orgOf(ownership), ownership.type === 'user' ? ownership.ownerUserId : null,
    ownership.type === 'team' ? ownership.workspaceId : null, authorization.actor.userId, now]);
  await history(database, resourceRef, authorization.actor, 'adopt', 1, 1, now);
  return (await findOnConnection(database, resourceRef))!;
}
