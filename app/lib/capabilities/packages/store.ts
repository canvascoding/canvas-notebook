import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { openDb, type SqlConnection } from '@/app/lib/db';
import {resolveOrganizationDataRoot,resolveUserDataRoot} from '@/app/lib/runtime-data-paths';
import type { CapabilityResourceActor, CapabilityResourceOwnerScope, CapabilityResourceStorageBinding, CapabilityResourceGrantInput } from '../resources/contracts';
import { authority } from '../scope-authority';
import { createCapabilityPackageTargetOnConnection, isAuthorizedCapabilityPackageResource, isHeldCapabilityPackageResource,
  withAuthorizedCapabilityPackageResource, withAuthorizedCapabilityPackageTarget } from '../resources/store';
import { CAPABILITY_PACKAGE_CONTRACT_VERSION, CAPABILITY_PACKAGE_LIMITS, CAPABILITY_PACKAGE_DRAFT_LIST_LIMITS, CapabilityPackageError,
  type AuthorizedCapabilityPackageResource, type CapabilityPackageDraft, type CapabilityPackageDraftCreation,
  type CapabilityPackageDraftSeed, type CapabilityPackageExpectedHead, type CapabilityPackagePublicationResult,
  type CapabilityPackagePublishedRevision, type CapabilityPackagePublishRequest, type CapabilityPackageSourceStamp,
  type CapabilityPackageState, type CapabilityPackagePublishedSummary, type CapabilityPackageOwnedDraftStatus,
  type CapabilityPackageOwnedDraftList, type CapabilityPackageOwnedDraftListQuery } from './contracts';
import type { CapabilityPackageSourceDraftCreation, CapabilityPackageOperationStatus, CapabilityPackageOperationQuery } from './contracts';
import { deriveCapabilityStoreOrigin, normalizeCapabilityStoreOrigin, sameCapabilityStoreOrigin, type CapabilityStoreOrigin } from './store-origin';
import { assertPreparedCapabilityStorePackage, getPreparedCapabilityStorePackage, type PreparedCapabilityStorePackage } from './store-source';
import type { CapabilityPackageStoreUpdateRequest } from './store-contracts';
import { readHeldLegacyCapabilityStoreHistory, type PreparedLegacyCapabilityStoreHistory } from './legacy-store-source';

type Row = Record<string, unknown>;
export type CapabilityPackageDraftRecord = { draft: CapabilityPackageDraft; targetStorage: CapabilityResourceStorageBinding;
  targetOwnership: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>;
  sourceStorage: CapabilityResourceStorageBinding | null; sourceParentStorage?: CapabilityResourceStorageBinding };
type PrivateDraft = CapabilityPackageDraftRecord;
export type CapabilityPackagePublicationBinding = { revisionRef: string; version: string; checksum: string; rootPath: string; storeOrigin?: CapabilityStoreOrigin };
type Publication = { authorization: AuthorizedCapabilityPackageResource; binding: CapabilityPackagePublicationBinding; database: SqlConnection };
const publicationKey = Symbol.for('canvas.capability.package-publication.v1');
const publicationGlobal = globalThis as typeof globalThis & { [publicationKey]?: AsyncLocalStorage<Publication> };
const publications = publicationGlobal[publicationKey] ??= new AsyncLocalStorage<Publication>();
type OriginPreparation = { authorization: AuthorizedCapabilityPackageResource; database: SqlConnection; revisionRef: string; expectedOrigin?: CapabilityStoreOrigin;
  source?: { rootPath: string; checksum: string } };
const originPreparationKey = Symbol.for('canvas.capability.package-origin-preparation.v1');
const originPreparationGlobal = globalThis as typeof globalThis & { [originPreparationKey]?: AsyncLocalStorage<OriginPreparation> };
const originPreparations = originPreparationGlobal[originPreparationKey] ??= new AsyncLocalStorage<OriginPreparation>();
export type CapabilityPackageActivationBinding=CapabilityPackagePublicationBinding & {previousEnabled:boolean};
type Activation={authorization:AuthorizedCapabilityPackageResource;binding:CapabilityPackageActivationBinding;enabled:boolean;database:SqlConnection};
const activationKey=Symbol.for('canvas.capability.package-activation.v1');
const activationGlobal=globalThis as typeof globalThis & {[activationKey]?:AsyncLocalStorage<Activation>};
const activations=activationGlobal[activationKey]??=new AsyncLocalStorage<Activation>();

function fail(code: ConstructorParameters<typeof CapabilityPackageError>[0], message: string, status = 400): never {
  throw new CapabilityPackageError(code, message, status);
}
function text(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) fail('PACKAGE_REQUEST_INVALID', `${label} is invalid.`);
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('PACKAGE_REQUEST_INVALID', 'A package revision is required.');
  return Number(value);
}
function actorSnapshot(actor: CapabilityResourceActor): CapabilityResourceActor {
  return Object.freeze({ userId: text(actor.userId, 'Actor'), workspaceId: actor.workspaceId == null ? null : text(actor.workspaceId, 'Workspace') });
}
function sameActor(left: CapabilityResourceActor, right: CapabilityResourceActor): boolean {
  return left.userId === right.userId && (left.workspaceId ?? null) === (right.workspaceId ?? null);
}
function sameStorage(left: CapabilityResourceStorageBinding, right: CapabilityResourceStorageBinding): boolean {
  return ['resourceType', 'resourceId', 'scopeType', 'name', 'sourceType', 'organizationId', 'ownerUserId', 'sourcePluginId']
    .every(key => left[key as keyof CapabilityResourceStorageBinding] === right[key as keyof CapabilityResourceStorageBinding]);
}
function json<T>(value: unknown): T {
  if (typeof value !== 'string') fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'Stored package metadata is unavailable.', 503);
  try { return JSON.parse(value) as T; } catch { return fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'Stored package metadata is unavailable.', 503); }
}
function stampSnapshot(stamp: CapabilityPackageSourceStamp): CapabilityPackageSourceStamp {
  const result = structuredClone(stamp);
  text(result.resourceId, 'Source reference'); text(result.name, 'Source name', 200); text(result.version, 'Source version', 200);
  if (!['skill', 'plugin'].includes(result.kind) || typeof result.registryChecksum !== 'string' || result.registryChecksum.length > 256
    || !/^[a-f0-9]{64}$/u.test(result.checksum) || result.artifactRevision !== null && (!Number.isSafeInteger(result.artifactRevision) || result.artifactRevision < 0)) {
    fail('PACKAGE_REQUEST_INVALID', 'The package source stamp is invalid.');
  }
  if (result.storeOrigin !== undefined) {
    const origin = normalizeCapabilityStoreOrigin(result.storeOrigin, result.resourceId);
    if (!origin) fail('PACKAGE_REQUEST_INVALID', 'The package source origin is invalid.');
    result.storeOrigin = origin;
  }
  if(result.dependencies!==undefined) {
    if(!Array.isArray(result.dependencies)||result.dependencies.length>CAPABILITY_PACKAGE_LIMITS.maxFiles) fail('PACKAGE_REQUEST_INVALID','The source dependency list is invalid.');
    const paths=new Set<string>();
    result.dependencies=result.dependencies.map(dependency=>{
      const {resourceId,name,version,checksum,relativeRoot}=dependency;
      text(resourceId,'Dependency reference');text(name,'Dependency name',200);text(version,'Dependency version',200);
      text(relativeRoot,'Dependency path',CAPABILITY_PACKAGE_LIMITS.maxRelativePathLength);
      const segments=relativeRoot.split('/');
      if(!/^[a-f0-9]{64}$/u.test(checksum)||relativeRoot.includes('\\')||path.posix.isAbsolute(relativeRoot)||/^[a-z]:/iu.test(relativeRoot)
        ||segments.length>CAPABILITY_PACKAGE_LIMITS.maxDepth||segments.some(segment=>!segment||segment==='.'||segment==='..')||paths.has(relativeRoot.toLowerCase())) {
        fail('PACKAGE_REQUEST_INVALID','The source dependency binding is invalid.');
      }
      paths.add(relativeRoot.toLowerCase());return {resourceId,name,version,checksum,relativeRoot};
    }).sort((left,right)=>left.relativeRoot.localeCompare(right.relativeRoot));
  }
  return result;
}
async function usingDatabase<T>(database: SqlConnection | undefined, callback: (database: SqlConnection) => Promise<T>): Promise<T> {
  if (database) return callback(database);
  const own = await openDb(); try { return await callback(own); } finally { await own.close(); }
}
function mapState(row: Row): CapabilityPackageState {
  return { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION, resourceRef: String(row.resource_ref), kind: row.kind as CapabilityPackageState['kind'],
    name: String(row.name), packageRevision: Number(row.package_revision), currentPublishedRevisionRef: String(row.current_published_revision_ref),
    currentSourceStamp: json<CapabilityPackageSourceStamp>(row.current_source_stamp), updatedByUserId: row.updated_by_user_id == null ? null : String(row.updated_by_user_id), updatedAt: Number(row.updated_at) };
}
function mapPublished(row: Row): CapabilityPackagePublishedRevision {
  return { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION, resourceRef: String(row.resource_ref), revisionRef: String(row.revision_ref),
    kind: row.kind as CapabilityPackagePublishedRevision['kind'], name: String(row.name), version: String(row.version), checksum: String(row.checksum),
    files: json(row.files), totalBytes: Number(row.total_bytes), publishedByUserId: row.published_by_user_id == null ? null : String(row.published_by_user_id),
    publishedAt: Number(row.published_at), baseRevisionRef: row.base_revision_ref == null ? null : String(row.base_revision_ref),
    sourceResourceRef:row.source_resource_ref==null?null:String(row.source_resource_ref),sourceRevisionRef:row.source_revision_ref==null?null:String(row.source_revision_ref),
    sourceChecksum:row.source_checksum==null?null:String(row.source_checksum),sourceStamp:row.source_stamp==null?null:json(row.source_stamp) };
}
function mapDraft(row: Row): PrivateDraft {
  const common = { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION, draftRef: String(row.draft_ref), resourceRef: String(row.resource_ref),
    kind: row.kind as CapabilityPackageDraft['kind'], name: String(row.name), operation: row.operation as CapabilityPackageDraft['operation'], actorUserId: String(row.actor_user_id),
    draftRevision: Number(row.draft_revision), basePackageRevision: Number(row.base_package_revision), basePublishedRevisionRef: row.base_published_revision_ref == null ? null : String(row.base_published_revision_ref),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  const draft: CapabilityPackageDraft = row.operation === 'create' ? { ...common, operation: 'create',
    baseSourceStamp: null, sourceResourceRef: null, sourceMetadataRevision: null, sourceGrantsRevision: null, sourcePackageRevision: null, sourcePublishedRevisionRef: null }
    : { ...common, operation: row.operation as 'edit' | 'fork', baseSourceStamp: json<CapabilityPackageSourceStamp>(row.base_source_stamp), sourceResourceRef: String(row.source_resource_ref), sourceMetadataRevision: Number(row.source_metadata_revision),
    sourceGrantsRevision: Number(row.source_grants_revision),sourcePackageRevision:Number(row.source_package_revision),
    sourcePublishedRevisionRef:row.source_published_revision_ref==null?null:String(row.source_published_revision_ref) };
  return { draft, targetStorage: json(row.target_storage), targetOwnership: json(row.target_ownership), sourceStorage: row.source_storage==null?null:json(row.source_storage),
    ...(row.source_parent_storage ? { sourceParentStorage: json<CapabilityResourceStorageBinding>(row.source_parent_storage) } : {}) };
}
function assertHead(state: CapabilityPackageState | null, expected: CapabilityPackageExpectedHead): void {
  revision(expected.expectedPackageRevision);
  if (expected.expectedPublishedRevisionRef !== null) text(expected.expectedPublishedRevisionRef, 'Published revision');
  if ((state?.packageRevision ?? 0) !== expected.expectedPackageRevision
    || (state?.currentPublishedRevisionRef ?? null) !== expected.expectedPublishedRevisionRef) {
    fail('PACKAGE_REVISION_CONFLICT', 'The selected package revision changed. Inspect it again.', 409);
  }
}
function assertCurrentSource(state: CapabilityPackageState | null, stamp: CapabilityPackageSourceStamp): void {
  const canonical=(value:CapabilityPackageSourceStamp)=>JSON.stringify([value.resourceId,value.kind,value.name,value.version,value.artifactRevision,
    value.registryChecksum,value.checksum,value.sourcePluginId,value.parentResourceRef??null,value.parentRevisionRef??null,value.relativeRoot??null,
    (value.dependencies??[]).map(dependency=>[dependency.resourceId,dependency.name,dependency.version,dependency.checksum,dependency.relativeRoot]).sort((a,b)=>String(a[4]).localeCompare(String(b[4])))]);
  if (state && (canonical(state.currentSourceStamp) !== canonical(stamp)
    || !sameCapabilityStoreOrigin(state.currentSourceStamp.storeOrigin, stamp.storeOrigin))) fail('PACKAGE_SOURCE_CHANGED', 'The installed package pointer changed.', 409);
}

/** Internal metadata lookup. Content readers must first hold current resource authorization. */
export async function getCapabilityPackageState(resourceRef: string, database?: SqlConnection): Promise<CapabilityPackageState | null> {
  const ref = text(resourceRef, 'Resource reference');
  return usingDatabase(database, async db => { const row = await db.get('SELECT * FROM capability_package_states WHERE resource_ref=$1', [ref]) as Row | undefined; return row ? mapState(row) : null; });
}
export async function getCapabilityPackagePublishedRevision(resourceRef: string, revisionRef?: string | null, database?: SqlConnection): Promise<CapabilityPackagePublishedRevision | null> {
  const ref = text(resourceRef, 'Resource reference');
  return usingDatabase(database, async db => {
    const selected = revisionRef ?? (await getCapabilityPackageState(ref, db))?.currentPublishedRevisionRef;
    if (!selected) return null;
    const row = await db.get('SELECT * FROM capability_package_versions WHERE resource_ref=$1 AND revision_ref=$2', [ref, text(selected, 'Published revision')]) as Row | undefined;
    return row ? mapPublished(row) : null;
  });
}
/** Bounded history metadata; callers must keep current read authority held. */
export async function listCapabilityPackagePublishedRevisions(resourceRef:string,database?:SqlConnection):Promise<CapabilityPackagePublishedSummary[]> {
  const ref=text(resourceRef,'Resource reference');
  return usingDatabase(database,async db=>(await db.all(`SELECT resource_ref,revision_ref,kind,name,version,checksum,published_by_user_id,published_at,
    base_revision_ref,total_bytes,json_array_length(files::json) AS file_count FROM capability_package_versions
    WHERE resource_ref=$1 ORDER BY published_at DESC,revision_ref DESC LIMIT 100`,[ref]) as Row[]).map(row=>({resourceRef:String(row.resource_ref),revisionRef:String(row.revision_ref),
      kind:row.kind as CapabilityPackagePublishedSummary['kind'],name:String(row.name),version:String(row.version),checksum:String(row.checksum),
      publishedByUserId:row.published_by_user_id==null?null:String(row.published_by_user_id),publishedAt:Number(row.published_at),
      baseRevisionRef:row.base_revision_ref==null?null:String(row.base_revision_ref),fileCount:Number(row.file_count),totalBytes:Number(row.total_bytes)})));
}
export async function findCapabilityPackageStateForStorage(storage: CapabilityResourceStorageBinding, database?: SqlConnection): Promise<CapabilityPackageState | null> {
  return usingDatabase(database, async db => {
    const row = await db.get(`SELECT resource_ref FROM capability_resources WHERE legacy_resource_id=$1 AND resource_type=$2 AND artifact_name=$3
      AND storage_scope_type=$4 AND storage_organization_id IS NOT DISTINCT FROM $5 AND storage_owner_user_id IS NOT DISTINCT FROM $6
      AND source_type=$7 AND source_plugin_id IS NOT DISTINCT FROM $8`,
    [storage.resourceId, storage.resourceType, storage.name, storage.scopeType, storage.organizationId, storage.ownerUserId, storage.sourceType, storage.sourcePluginId]) as Row | undefined;
    return row ? getCapabilityPackageState(String(row.resource_ref), db) : null;
  });
}

/** Current SQL head and the staged registry marker must agree; an uncommitted file pointer is unusable. */
export async function assertCapabilityPackageCommittedReference(input: { resourceRef: string; revisionRef: string; version: string; checksum: string; storeOrigin?: CapabilityStoreOrigin }): Promise<void> {
  const state = await getCapabilityPackageState(input.resourceRef);
  const published = state ? await getCapabilityPackagePublishedRevision(input.resourceRef, state.currentPublishedRevisionRef) : null;
  if (!state || state.currentPublishedRevisionRef !== input.revisionRef || !published || published.version !== input.version || published.checksum !== input.checksum
    || 'storeOrigin' in input && !sameCapabilityStoreOrigin(state.currentSourceStamp.storeOrigin, input.storeOrigin)) {
    fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The installed package publication is unavailable.', 503);
  }
}

export async function getCapabilityPackageDraft(actorInput: CapabilityResourceActor, draftRef: string): Promise<CapabilityPackageDraft> {
  return (await getCapabilityPackageDraftRecord(actorInput,draftRef)).draft;
}

const ownedDraftStatusColumns = 'draft_ref,resource_ref,source_resource_ref,kind,name,draft_revision,operation,target_ownership,created_at,updated_at';
const canonicalResourceRef = /^canvas-resource:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const canonicalDraftRef = /^canvas-package-draft:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

function ownedDraftStatusUnavailable(): never {
  return fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'Stored package draft status is unavailable.', 503);
}
function ownedDraftStatusNumber(value: unknown, positive = false): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/u.test(value))) return ownedDraftStatusUnavailable();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (positive ? 1 : 0)) return ownedDraftStatusUnavailable();
  return result;
}
function ownedDraftStatusOwnership(value: unknown): CapabilityPackageOwnedDraftStatus['targetOwnership'] {
  if (typeof value !== 'string' || value.length > 1_024) return ownedDraftStatusUnavailable();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return ownedDraftStatusUnavailable(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ownedDraftStatusUnavailable();
  const owner = parsed as Row;
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f]/u.test(id);
  const exact = (fields: string[]) => Object.keys(owner).length === fields.length && fields.every(field => Object.hasOwn(owner, field));
  if (owner.type === 'user' && exact(['type','ownerUserId','organizationId']) && validId(owner.ownerUserId)
    && (owner.organizationId === null || validId(owner.organizationId))) {
    return { type: 'user', ownerUserId: owner.ownerUserId, organizationId: owner.organizationId };
  }
  if (owner.type === 'organization' && exact(['type','organizationId']) && validId(owner.organizationId)) {
    return { type: 'organization', organizationId: owner.organizationId };
  }
  if (owner.type === 'team' && exact(['type','organizationId','workspaceId']) && validId(owner.organizationId) && validId(owner.workspaceId)) {
    return { type: 'team', organizationId: owner.organizationId, workspaceId: owner.workspaceId };
  }
  return ownedDraftStatusUnavailable();
}
/** Only selected safe SQL columns are consumed, never a full private draft record. */
function projectOwnedDraftStatus(row: Row): CapabilityPackageOwnedDraftStatus {
  const { draft_ref: draftRef, resource_ref: resourceRef, source_resource_ref: sourceResourceRef, kind, name, operation } = row;
  const validSource = operation === 'create' ? sourceResourceRef === null : typeof sourceResourceRef === 'string' && sourceResourceRef.length <= 2_048
    && (canonicalResourceRef.test(sourceResourceRef) || sourceResourceRef.startsWith(`canvas-capability:v1:${String(kind)}:`) && /^[a-zA-Z0-9%_.:~-]+$/u.test(sourceResourceRef));
  if (typeof draftRef !== 'string' || !canonicalDraftRef.test(draftRef) || typeof resourceRef !== 'string' || !canonicalResourceRef.test(resourceRef)
    || !['skill','plugin'].includes(String(kind)) || typeof name !== 'string' || name !== name.trim().normalize('NFKC')
    || name !== name.toLowerCase() || Array.from(name).length > 64 || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)
    || kind === 'plugin' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || !['create','edit','fork'].includes(String(operation)) || !validSource) return ownedDraftStatusUnavailable();
  const createdAt = ownedDraftStatusNumber(row.created_at), updatedAt = ownedDraftStatusNumber(row.updated_at);
  if (updatedAt < createdAt) return ownedDraftStatusUnavailable();
  return { draftRef, resourceRef, sourceResourceRef: sourceResourceRef as string | null, kind: kind as CapabilityPackageOwnedDraftStatus['kind'], name, operation: operation as CapabilityPackageOwnedDraftStatus['operation'],
    draftRevision: ownedDraftStatusNumber(row.draft_revision, true), targetOwnership: ownedDraftStatusOwnership(row.target_ownership), createdAt, updatedAt };
}
async function assertOwnedDraftActor(database: SqlConnection, actor: CapabilityResourceActor): Promise<void> {
  const current = await authority(database, actor);
  if (!current.valid || !current.contextValid) fail('PACKAGE_ACCESS_DENIED', 'An active actor and workspace are required.', 403);
}
function ownedDraftCursorContext(actor: CapabilityResourceActor): string {
  return createHash('sha256').update(JSON.stringify([actor.userId, actor.workspaceId ?? null])).digest('hex');
}
function ownedDraftListQuery(value: CapabilityPackageOwnedDraftListQuery): { limit: number; cursor: string | undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'limit' && key !== 'cursor')) {
    return fail('PACKAGE_REQUEST_INVALID', 'The draft list query is invalid.');
  }
  const limit = value.limit === undefined ? CAPABILITY_PACKAGE_DRAFT_LIST_LIMITS.defaultLimit : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CAPABILITY_PACKAGE_DRAFT_LIST_LIMITS.maxLimit
    || value.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > CAPABILITY_PACKAGE_DRAFT_LIST_LIMITS.maxCursorLength)) {
    return fail('PACKAGE_REQUEST_INVALID', 'The draft list query is invalid.');
  }
  return { limit, cursor: value.cursor };
}
function decodeOwnedDraftCursor(cursor: string, actor: CapabilityResourceActor): { updatedAt: number; draftRef: string } {
  const invalid = (): never => fail('PACKAGE_REQUEST_INVALID', 'The draft list cursor is invalid.');
  if (!/^[a-zA-Z0-9_-]+$/u.test(cursor)) return invalid();
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) return invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return invalid(); }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1 || parsed[1] !== ownedDraftCursorContext(actor)
    || !Number.isSafeInteger(parsed[2]) || parsed[2] < 0 || typeof parsed[3] !== 'string' || !canonicalDraftRef.test(parsed[3])) return invalid();
  return { updatedAt: parsed[2] as number, draftRef: parsed[3] };
}
function encodeOwnedDraftCursor(status: CapabilityPackageOwnedDraftStatus, actor: CapabilityResourceActor): string {
  return Buffer.from(JSON.stringify([1, ownedDraftCursorContext(actor), status.updatedAt, status.draftRef])).toString('base64url');
}

/** Creator-only recovery metadata grants no source bytes, edit rights or filesystem receipt. */
export async function getCapabilityPackageOwnedDraftStatus(actorInput:CapabilityResourceActor,draftRef:string):Promise<CapabilityPackageOwnedDraftStatus> {
  const actor=actorSnapshot(actorInput),ref=text(draftRef,'Draft reference');
  return usingDatabase(undefined,async database=>{
    await assertOwnedDraftActor(database, actor);
    const row=await database.get(`SELECT ${ownedDraftStatusColumns} FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2`,[ref,actor.userId]) as Row|undefined;
    if(!row)fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
    return projectOwnedDraftStatus(row);
  });
}

/** Actor-bound keyset pagination; a cursor never grants source, target or another creator's rights. */
export async function listCapabilityPackageOwnedDraftStatuses(actorInput: CapabilityResourceActor,
  queryInput: CapabilityPackageOwnedDraftListQuery = {}): Promise<CapabilityPackageOwnedDraftList> {
  const actor = actorSnapshot(actorInput), query = ownedDraftListQuery(queryInput);
  const cursor = query.cursor ? decodeOwnedDraftCursor(query.cursor, actor) : null;
  return usingDatabase(undefined, async database => {
    await assertOwnedDraftActor(database, actor);
    const rows = await database.all(`SELECT ${ownedDraftStatusColumns} FROM capability_package_drafts WHERE actor_user_id=$1
      ${cursor ? 'AND (updated_at < $2 OR (updated_at = $2 AND draft_ref > $3))' : ''}
      ORDER BY updated_at DESC,draft_ref ASC LIMIT $${cursor ? 4 : 2}`,
    cursor ? [actor.userId,cursor.updatedAt,cursor.draftRef,query.limit + 1] : [actor.userId,query.limit + 1]) as Row[];
    const statuses = rows.map(projectOwnedDraftStatus), drafts = statuses.slice(0, query.limit);
    return { drafts, nextCursor: statuses.length > query.limit ? encodeOwnedDraftCursor(drafts[drafts.length - 1], actor) : null };
  });
}

function operationRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function lockOperationRequest(database: SqlConnection, actor: CapabilityResourceActor, requestId?: string): Promise<void> {
  if (requestId) await database.get('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`capability-package-request:${actor.userId}:${requestId}`]);
}

async function operationForRequest(database: SqlConnection, actor: CapabilityResourceActor, requestId: string, hash: string): Promise<Row | undefined> {
  const row = await database.get('SELECT * FROM capability_package_operations WHERE actor_user_id=$1 AND request_id=$2', [actor.userId, requestId]) as Row | undefined;
  if (row && row.request_hash !== hash) fail('PACKAGE_REQUEST_CONFLICT', 'This request identifier was already used for another package operation.', 409);
  return row;
}

function publicationRequestHash(request: CapabilityPackagePublishRequest): string {
  return operationRequestHash(['publish',request.draftRef,request.expectedDraftRevision,request.expectedMetadataRevision,request.expectedGrantsRevision,
    request.expectedPackageRevision,request.expectedPublishedRevisionRef]);
}

/** Full replay results still require today's read permission. Recovery metadata uses a separate path. */
export async function findCapabilityPackagePublicationReplay(actorInput: CapabilityResourceActor, request: CapabilityPackagePublishRequest): Promise<{
  state: CapabilityPackageState; published: CapabilityPackagePublishedRevision;
} | null> {
  const actor = actorSnapshot(actorInput);
  return usingDatabase(undefined, async database => {
    await assertOwnedDraftActor(database, actor);
    const hash = publicationRequestHash(request);
    const byRequest = request.requestId ? await operationForRequest(database,actor,request.requestId,hash) : undefined;
    const row = byRequest ?? await database.get(`SELECT * FROM capability_package_operations WHERE actor_user_id=$1 AND draft_ref=$2
      AND draft_revision=$3 AND operation='publish'`, [actor.userId,request.draftRef,request.expectedDraftRevision]) as Row | undefined;
    if (!row) return null;
    if (row.operation !== 'publish' || row.request_hash !== hash) fail('PACKAGE_REQUEST_CONFLICT', 'The publication request differs from the completed operation.', 409);
    const storage = json<CapabilityResourceStorageBinding>(row.target_storage);
    return withAuthorizedCapabilityPackageResource(actor,storage,'read',undefined,async () => {
      const result = json<{state:CapabilityPackageState;published:CapabilityPackagePublishedRevision}>(row.result);
      if (result.published.resourceRef !== row.resource_ref || result.published.revisionRef !== row.published_revision_ref) {
        fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The publication result is unavailable.', 503);
      }
      return result;
    });
  });
}

async function recordPackageOperation(database: SqlConnection, actor: CapabilityResourceActor, input: {
  requestId?: string; requestHash: string; operation: CapabilityPackageOperationStatus['operation']; status: CapabilityPackageOperationStatus['status'];
  draft: CapabilityPackageDraft; targetStorage: CapabilityResourceStorageBinding; publishedRevisionRef?: string; result?: unknown;
}): Promise<void> {
  const now = Date.now(), draft = input.draft;
  await database.run(`INSERT INTO capability_package_operations (operation_ref,actor_user_id,request_id,request_hash,operation,status,
    draft_ref,draft_revision,resource_ref,published_revision_ref,kind,name,target_storage,result,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
  [randomUUID(),actor.userId,input.requestId ?? null,input.requestHash,input.operation,input.status,draft.draftRef,draft.draftRevision,draft.resourceRef,
    input.publishedRevisionRef ?? null,draft.kind,draft.name,JSON.stringify(input.targetStorage),input.result === undefined ? null : JSON.stringify(input.result),now]);
}

const operationStatusColumns = 'o.request_id,o.operation,o.status,o.draft_ref,o.draft_revision,o.resource_ref,o.published_revision_ref,o.kind,o.name,o.created_at,o.updated_at';

/** Recovery is creator metadata only, including after source/target access was revoked. */
export async function getCapabilityPackageOperationStatus(actorInput: CapabilityResourceActor, query: CapabilityPackageOperationQuery): Promise<CapabilityPackageOperationStatus> {
  const actor = actorSnapshot(actorInput);
  return usingDatabase(undefined, async database => {
    await assertOwnedDraftActor(database, actor);
    const value = 'requestId' in query ? query.requestId : query.draftRef;
    const row = await database.get(`SELECT ${operationStatusColumns},d.draft_revision AS current_draft_revision,d.updated_at AS current_draft_updated_at
      FROM capability_package_operations o LEFT JOIN capability_package_drafts d ON d.actor_user_id=o.actor_user_id AND d.draft_ref=o.draft_ref
      WHERE o.actor_user_id=$1 AND o.${'requestId' in query ? 'request_id' : 'draft_ref'}=$2
      ORDER BY CASE o.operation WHEN 'publish' THEN 0 WHEN 'discard' THEN 1 ELSE 2 END,o.updated_at DESC LIMIT 1`, [actor.userId,value]) as Row | undefined;
    if (!row) fail('PACKAGE_NOT_FOUND', 'The package operation was not found.', 404);
    if (!canonicalDraftRef.test(String(row.draft_ref)) || !canonicalResourceRef.test(String(row.resource_ref))
      || !['create','publish','discard'].includes(String(row.operation)) || !['draft','published','discarded'].includes(String(row.status))
      || !['skill','plugin'].includes(String(row.kind)) || typeof row.name !== 'string' || row.name.length > 64
      || row.name !== row.name.trim().normalize('NFKC') || row.name !== row.name.toLowerCase() || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(row.name)
      || row.request_id !== null && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(String(row.request_id))
      || row.status === 'published' && row.published_revision_ref === null
      || row.published_revision_ref !== null && !/^canvas-package-revision:[a-f0-9-]{36}$/u.test(String(row.published_revision_ref))) return ownedDraftStatusUnavailable();
    let draftRevision = ownedDraftStatusNumber(row.draft_revision, true), updatedAt = ownedDraftStatusNumber(row.updated_at);
    if (row.status === 'draft') {
      if (row.current_draft_revision == null) return ownedDraftStatusUnavailable();
      draftRevision = ownedDraftStatusNumber(row.current_draft_revision, true); updatedAt = Math.max(updatedAt,ownedDraftStatusNumber(row.current_draft_updated_at));
    }
    return { requestId: row.request_id == null ? null : String(row.request_id), operation: row.operation as CapabilityPackageOperationStatus['operation'],
      status: row.status as CapabilityPackageOperationStatus['status'], draftRef: String(row.draft_ref), draftRevision, resourceRef: String(row.resource_ref),
      publishedRevisionRef: row.published_revision_ref == null ? null : String(row.published_revision_ref), kind: row.kind as CapabilityPackageOperationStatus['kind'], name: row.name,
      createdAt: ownedDraftStatusNumber(row.created_at), updatedAt };
  });
}

export async function beginNewCapabilityPackageDraft(actorInput: CapabilityResourceActor,
  input: Extract<CapabilityPackageDraftCreation, { operation: 'create' }>, target: AuthorizedCapabilityPackageResource,
  callback: (draft: CapabilityPackageDraft) => Promise<void>): Promise<CapabilityPackageDraft> {
  const actor = actorSnapshot(actorInput), owner = target.record.metadata.ownership;
  if (!isAuthorizedCapabilityPackageResource(target) || !sameActor(actor,target.actor) || !target.access.canManage
    || owner.type !== 'organization' || target.record.storage.resourceType !== input.kind || target.record.storage.name !== input.targetName) {
    fail('PACKAGE_ACCESS_DENIED', 'Creating a package requires current organization management permission.', 403);
  }
  return withAuthorizedCapabilityPackageTarget(actor,target.record.storage,owner,async (_held,database) => {
    await lockOperationRequest(database,actor,input.requestId);
    const requestHash = operationRequestHash(['create',input.kind,input.targetName,owner.organizationId]);
    const prior = await operationForRequest(database,actor,input.requestId,requestHash);
    if (prior) {
      if (prior.status !== 'draft') fail('PACKAGE_DRAFT_CONFLICT', 'This draft was already consumed. Inspect its operation result.', 409);
      const row = await database.get('SELECT * FROM capability_package_drafts WHERE actor_user_id=$1 AND draft_ref=$2 FOR SHARE', [actor.userId,prior.draft_ref]) as Row | undefined;
      if (!row) fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The recovered draft is unavailable.', 503);
      return mapDraft(row).draft;
    }
    const now = Date.now();
    const draft: CapabilityPackageDraft = { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION, draftRef: `canvas-package-draft:${randomUUID()}`,
      resourceRef: `canvas-resource:${randomUUID()}`,kind:input.kind,name:input.targetName,operation:'create',actorUserId:actor.userId,draftRevision:1,
      basePackageRevision:0,basePublishedRevisionRef:null,baseSourceStamp:null,sourceResourceRef:null,sourceMetadataRevision:null,sourceGrantsRevision:null,
      sourcePackageRevision:null,sourcePublishedRevisionRef:null,createdAt:now,updatedAt:now };
    await database.run(`INSERT INTO capability_package_drafts (draft_ref,resource_ref,actor_user_id,kind,name,operation,draft_revision,base_package_revision,
      base_published_revision_ref,base_source_stamp,source_resource_ref,source_metadata_revision,source_grants_revision,source_package_revision,source_published_revision_ref,source_storage,source_parent_storage,target_storage,target_ownership,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'create',1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$6,$7,$8,$8)`,
    [draft.draftRef,draft.resourceRef,actor.userId,draft.kind,draft.name,JSON.stringify(target.record.storage),JSON.stringify(owner),now]);
    await callback(Object.freeze(structuredClone(draft)));
    await recordPackageOperation(database,actor,{requestId:input.requestId,requestHash,operation:'create',status:'draft',draft,targetStorage:target.record.storage});
    return draft;
  });
}

/** Server-only private bindings. Never serialize this record in an API response. */
export async function getCapabilityPackageDraftRecord(actorInput: CapabilityResourceActor, draftRef: string): Promise<CapabilityPackageDraftRecord & {authorization:AuthorizedCapabilityPackageResource}> {
  return withCapabilityPackageDraftRead(actorInput,draftRef,async record=>record);
}

/** Keeps the creator's current source/target authority and exact draft generation held through byte reads. */
export async function withCapabilityPackageDraftRead<T>(actorInput:CapabilityResourceActor,draftRef:string,
  callback:(record:CapabilityPackageDraftRecord & {authorization:AuthorizedCapabilityPackageResource},database:SqlConnection)=>Promise<T>):Promise<T> {
  const actor = actorSnapshot(actorInput);
  const ref=text(draftRef,'Draft reference');
  const row=await usingDatabase(undefined,async db=>db.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[ref,actor.userId])) as Row|undefined;
  if(!row) fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
  return withDraftAuthorization(actor,mapDraft(row),async(authorization,database)=>{
    const current=await database.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2 FOR SHARE',[ref,actor.userId]) as Row|undefined;
    if(!current) fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
    return callback({...structuredClone(mapDraft(current)),authorization},database);
  });
}

async function withDraftAuthorization<T>(actor: CapabilityResourceActor, stored: PrivateDraft,
  callback: (authorization: AuthorizedCapabilityPackageResource, database: SqlConnection) => Promise<T>): Promise<T> {
  const { draft } = stored;
  if (actor.userId !== draft.actorUserId) fail('PACKAGE_NOT_FOUND', 'The package draft was not found.', 404);
  if (draft.operation === 'edit') return withAuthorizedCapabilityPackageResource(actor, stored.targetStorage, 'edit', undefined, callback);
  if (draft.operation === 'create') return withAuthorizedCapabilityPackageTarget(actor, stored.targetStorage, stored.targetOwnership, callback);
  if (!stored.sourceStorage) fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The draft source is unavailable.', 503);
  const sourceStorage = stored.sourceStorage;
  return withAuthorizedCapabilityPackageTarget(actor, stored.targetStorage, stored.targetOwnership, async (target, database) =>
    withAuthorizedCapabilityPackageResource(actor, sourceStorage, 'read', undefined, async () => callback(target, database),
      { parentStorage: stored.sourceParentStorage, database }));
}

export async function beginCapabilityPackageDraft(actorInput: CapabilityResourceActor, input: CapabilityPackageSourceDraftCreation,
  seed: CapabilityPackageDraftSeed, callback: (draft: CapabilityPackageDraft, database: SqlConnection) => Promise<void>): Promise<CapabilityPackageDraft> {
  const actor = actorSnapshot(actorInput), request = structuredClone(input), source = seed.source, sourceAuth = source.authorization;
  if (!isAuthorizedCapabilityPackageResource(sourceAuth) || !sameActor(actor, sourceAuth.actor) || !sourceAuth.access.canRead
    || sourceAuth.record.metadata.resourceRef !== request.resourceRef || !sameStorage(source.storage, sourceAuth.record.storage)) {
    fail('PACKAGE_ACCESS_DENIED', 'The package source is not authorized.', 403);
  }
  const stamp = stampSnapshot(source.sourceStamp), fork = request.operation === 'fork';
  const target = fork ? seed.target : sourceAuth;
  if (!target || !isAuthorizedCapabilityPackageResource(target) || !sameActor(actor, target.actor)
    || (fork ? !target.access.canManage || target.record.metadata.metadataRevision !== 0 : !sourceAuth.access.canEdit || source.readOnly)) {
    fail('PACKAGE_ACCESS_DENIED', 'The package draft is not authorized.', 403);
  }
  if (fork && (request.targetName !== target.record.storage.name || request.targetName === sourceAuth.record.storage.name
    || target.record.storage.resourceType !== source.storage.resourceType)) fail('PACKAGE_NAMESPACE_CONFLICT', 'The new package needs a distinct target name.', 409);
  const expected = fork ? { expectedMetadataRevision: request.expectedSourceMetadataRevision, expectedGrantsRevision: request.expectedSourceGrantsRevision }
    : { expectedMetadataRevision: request.expectedMetadataRevision, expectedGrantsRevision: request.expectedGrantsRevision };
  const create = (database?:SqlConnection) => withAuthorizedCapabilityPackageResource(actor, source.storage, fork ? 'read' : 'edit', expected, async (authorization, database) => {
    const state = await getCapabilityPackageState(authorization.record.metadata.resourceRef, database);
    assertHead(state, fork ? { expectedPackageRevision: request.expectedSourcePackageRevision, expectedPublishedRevisionRef: request.expectedSourcePublishedRevisionRef } : request);
    assertCurrentSource(state, stamp);
    if (!fork && authorization.record.metadata.metadataRevision === 0) fail('PACKAGE_REQUEST_INVALID', 'Adopt the editable resource before creating its package draft.');
    const now = Date.now();
    const draft: CapabilityPackageDraft = { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION, draftRef: `canvas-package-draft:${randomUUID()}`,
      resourceRef: fork ? `canvas-resource:${randomUUID()}` : authorization.record.metadata.resourceRef,
      kind: target.record.storage.resourceType, name: target.record.storage.name, operation: fork ? 'fork' : 'edit', actorUserId: actor.userId,
      draftRevision: 1, basePackageRevision: fork ? 0 : state?.packageRevision ?? 0, basePublishedRevisionRef: fork ? null : state?.currentPublishedRevisionRef ?? null,
      baseSourceStamp: stamp, sourceResourceRef: authorization.record.metadata.resourceRef,
      sourceMetadataRevision: authorization.record.metadata.metadataRevision, sourceGrantsRevision: authorization.record.metadata.grantsRevision,
      sourcePackageRevision:state?.packageRevision??0,sourcePublishedRevisionRef:state?.currentPublishedRevisionRef??null,createdAt: now, updatedAt: now };
    await database.run(`INSERT INTO capability_package_drafts (draft_ref,resource_ref,actor_user_id,kind,name,operation,draft_revision,base_package_revision,
      base_published_revision_ref,base_source_stamp,source_resource_ref,source_metadata_revision,source_grants_revision,source_package_revision,source_published_revision_ref,source_storage,source_parent_storage,target_storage,target_ownership,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
    [draft.draftRef,draft.resourceRef,actor.userId,draft.kind,draft.name,draft.operation,draft.basePackageRevision,draft.basePublishedRevisionRef,JSON.stringify(stamp),draft.sourceResourceRef,
      draft.sourceMetadataRevision,draft.sourceGrantsRevision,draft.sourcePackageRevision,draft.sourcePublishedRevisionRef,JSON.stringify(source.storage),source.parentStorage ? JSON.stringify(source.parentStorage) : null,
      JSON.stringify(target.record.storage),JSON.stringify(target.record.metadata.ownership),now]);
    await callback(Object.freeze(structuredClone(draft)), database);
    return draft;
  }, { parentStorage: source.parentStorage,database });
  if (fork) {
    const targetOwner=target.record.metadata.ownership;
    if(targetOwner.type==='system' || request.ownership.type!==targetOwner.type
      || targetOwner.type==='team' && (request.ownership.type!=='team' || request.ownership.workspaceId!==targetOwner.workspaceId)) {
      fail('PACKAGE_ACCESS_DENIED','The requested target ownership changed.',403);
    }
    return withAuthorizedCapabilityPackageTarget(actor,target.record.storage,targetOwner,async(_target,database)=>create(database));
  }
  return create();
}

export async function mutateCapabilityPackageDraft<T>(actorInput: CapabilityResourceActor, draftRef: string, expectedDraftRevision: number,
  callback: (draft: CapabilityPackageDraft, database: SqlConnection) => Promise<T>): Promise<{ draft: CapabilityPackageDraft; result: T }> {
  const actor = actorSnapshot(actorInput), ref = text(draftRef, 'Draft reference'), expected = revision(expectedDraftRevision);
  const row = await usingDatabase(undefined, async db => db.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2', [ref, actor.userId])) as Row | undefined;
  if (!row) fail('PACKAGE_NOT_FOUND', 'The package draft was not found.', 404);
  return withDraftAuthorization(actor, mapDraft(row), async (_authorization, database) => {
    const locked = await database.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2 FOR UPDATE', [ref, actor.userId]) as Row | undefined;
    if (!locked) fail('PACKAGE_NOT_FOUND', 'The package draft was not found.', 404);
    const draft = mapDraft(locked).draft;
    if (draft.draftRevision !== expected) fail('PACKAGE_DRAFT_CONFLICT', 'The package draft changed. Reload it before editing.', 409);
    const next = { ...draft, draftRevision: draft.draftRevision + 1, updatedAt: Date.now() };
    // IO clones current r to a private r+1 and returns before the SQL head advances.
    const result = await callback(Object.freeze(structuredClone(draft)), database);
    const changed = await database.run('UPDATE capability_package_drafts SET draft_revision=$1,updated_at=$2 WHERE draft_ref=$3 AND actor_user_id=$4 AND draft_revision=$5', [next.draftRevision,next.updatedAt,ref,actor.userId,expected]) as { changes?: number };
    if (changed.changes !== 1) fail('PACKAGE_DRAFT_CONFLICT', 'The package draft changed during editing.', 409);
    return { draft: next, result };
  });
}

export async function discardCapabilityPackageDraft(actorInput: CapabilityResourceActor, draftRef: string, expectedDraftRevision: number,
  callback: (draft: CapabilityPackageDraft, database: SqlConnection) => Promise<void>): Promise<void> {
  const actor = actorSnapshot(actorInput), ref = text(draftRef, 'Draft reference'), expected = revision(expectedDraftRevision);
  // Discard is private cleanup; a revoked editor must still be able to remove their own draft.
  const database = await openDb();
  try {
    await database.run('BEGIN');
    const currentActor = await authority(database,actor,true);
    if (!currentActor.valid || !currentActor.contextValid) fail('PACKAGE_ACCESS_DENIED','An active actor and workspace are required.',403);
    const row = await database.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2 FOR UPDATE', [ref,actor.userId]) as Row | undefined;
    if (!row) fail('PACKAGE_NOT_FOUND', 'The package draft was not found.', 404);
    const draft = mapDraft(row).draft;
    if (draft.draftRevision !== expected) fail('PACKAGE_DRAFT_CONFLICT', 'The package draft changed. Reload before discarding it.', 409);
    await callback(Object.freeze(structuredClone(draft)),database);
    const stored = mapDraft(row);
    await recordPackageOperation(database,actor,{requestHash:operationRequestHash(['discard',ref,expected]),operation:'discard',status:'discarded',draft,targetStorage:stored.targetStorage});
    await database.run("UPDATE capability_package_operations SET status='discarded',draft_revision=$1,updated_at=$2 WHERE actor_user_id=$3 AND draft_ref=$4 AND operation='create'", [draft.draftRevision,Date.now(),actor.userId,ref]);
    await database.run('DELETE FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2', [ref,actor.userId]);
    await database.run('COMMIT');
  } catch (error) { try { await database.run('ROLLBACK'); } catch { /* Preserve the original error. */ } throw error; }
  finally { await database.close(); }
}

export async function withCapabilityPackagePublication<T>(authorization: AuthorizedCapabilityPackageResource,
  bindingInput: CapabilityPackagePublicationBinding, database: SqlConnection, callback: () => Promise<T>): Promise<T> {
  if (!isHeldCapabilityPackageResource(authorization,database) || !authorization.access.canEdit || !['edit','publish'].includes(authorization.operation)) {
    fail('PACKAGE_ACCESS_DENIED', 'The package publication is not authorized.',403);
  }
  const binding = Object.freeze(structuredClone(bindingInput));
  if (!/^canvas-package-revision:[a-f0-9-]{36}$/u.test(binding.revisionRef) || !/^[a-f0-9]{64}$/u.test(binding.checksum)
    || !path.isAbsolute(binding.rootPath)) fail('PACKAGE_REQUEST_INVALID','The publication binding is invalid.');
  text(binding.version,'Version',200);
  const preparing = originPreparations.getStore();
  if (preparing && (preparing.authorization !== authorization || preparing.database !== database || preparing.revisionRef !== binding.revisionRef)) {
    fail('PACKAGE_ACCESS_DENIED', 'The package origin is not bound to this publication.', 403);
  }
  // Shape-valid JSON cannot add a Store history to an authorized content publication.
  if (!sameCapabilityStoreOrigin(binding.storeOrigin, preparing?.expectedOrigin)) fail('PACKAGE_ACCESS_DENIED', 'The package origin does not match its held draft source.', 403);
  return publications.run({authorization,binding,database},callback);
}
export function isCapabilityPackagePublicationAllowed(storage: CapabilityResourceStorageBinding,
  next?: {version:string;checksum:string;installDir?:string;storeOrigin?:CapabilityStoreOrigin}): boolean {
  const current = publications.getStore();
  return Boolean(current && isHeldCapabilityPackageResource(current.authorization,current.database)
    && sameStorage(current.authorization.record.storage,storage)
    && (!next || next.version === current.binding.version && next.checksum === current.binding.checksum
      && (!next.installDir || path.resolve(next.installDir) === path.resolve(current.binding.rootPath))
      && (!('storeOrigin' in next) || sameCapabilityStoreOrigin(next.storeOrigin, current.binding.storeOrigin))));
}
/** Only the exact held SQL publication may expose the draft-derived origin to a registry builder. */
export function getCapabilityPackagePublicationStoreOrigin(storage: CapabilityResourceStorageBinding): CapabilityStoreOrigin | undefined {
  if (!isCapabilityPackagePublicationAllowed(storage)) fail('PACKAGE_ACCESS_DENIED', 'The package origin requires a held publication.', 403);
  const origin = publications.getStore()?.binding.storeOrigin;
  return origin ? normalizeCapabilityStoreOrigin(origin, storage.resourceId) ?? undefined : undefined;
}
export async function assertCapabilityPackageLegacyMutationAllowed(storage: CapabilityResourceStorageBinding,
  next?: {version:string;checksum:string;installDir?:string}): Promise<void> {
  if (isCapabilityPackagePublicationAllowed(storage,next)) return;
  if (await findCapabilityPackageStateForStorage(storage)) fail('PACKAGE_REVISION_CONFLICT','This package is version managed. Edit and publish its full package draft.',409);
}

/** Default activation is independent of content publication, grants, runtime use and editing. */
export async function withCapabilityPackageActivation<T>(authorization:AuthorizedCapabilityPackageResource,
  bindingInput:CapabilityPackageActivationBinding,enabled:boolean,database:SqlConnection,callback:()=>Promise<T>):Promise<T> {
  if(!isHeldCapabilityPackageResource(authorization,database)||authorization.operation!=='read'||!authorization.access.canManage) {
    fail('PACKAGE_ACCESS_DENIED','Package management permission is required.',403);
  }
  const binding=Object.freeze(structuredClone(bindingInput));
  if(typeof enabled!=='boolean'||typeof binding.previousEnabled!=='boolean'||!/^canvas-package-revision:[a-f0-9-]{36}$/u.test(binding.revisionRef))fail('PACKAGE_REQUEST_INVALID','The activation binding is invalid.');
  const ref=authorization.record.metadata.resourceRef,state=await getCapabilityPackageState(ref,database);
  const published=state?await getCapabilityPackagePublishedRevision(ref,state.currentPublishedRevisionRef,database):null;
  const owner=authorization.record.metadata.ownership;
  if(!state||!published||state.currentPublishedRevisionRef!==binding.revisionRef||published.version!==binding.version||published.checksum!==binding.checksum||owner.type==='system') {
    fail('PACKAGE_REVISION_CONFLICT','The package publication changed. Inspect it before changing its default.',409);
  }
  const root=owner.type==='user'?resolveUserDataRoot(owner.ownerUserId):resolveOrganizationDataRoot(owner.organizationId);
  const expected=path.join(root,'capability-packages','published',ref.replace(/^canvas-resource:/u,''),binding.revisionRef.replace(/^canvas-package-revision:/u,''),authorization.record.storage.name);
  if(path.resolve(binding.rootPath)!==path.resolve(expected))fail('PACKAGE_ACCESS_DENIED','The package activation path is not authorized.',403);
  return activations.run({authorization,binding,enabled,database},callback);
}

function canonicalRecord(value:unknown):string {
  const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(normalize):item&&typeof item==='object'
    ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalize(value)])):item;
  return JSON.stringify(normalize(value));
}
export function isCapabilityPackageActivationAllowed(storage:CapabilityResourceStorageBinding,before:Record<string,unknown>,after:Record<string,unknown>):boolean {
  const current=activations.getStore();
  if(!current||!isHeldCapabilityPackageResource(current.authorization,current.database)||!sameStorage(storage,current.authorization.record.storage))return false;
  const field=storage.resourceType==='plugin'?'enabled':'packageDefaultEnabled';
  const previous=storage.resourceType==='plugin'?before.enabled:before.packageDefaultEnabled!==false;
  if(previous!==current.binding.previousEnabled||after[field]!==current.enabled)return false;
  for(const entry of [before,after])if(entry.packageManaged!==true||entry.packageResourceRef!==current.authorization.record.metadata.resourceRef
    ||entry.publishedRevisionRef!==current.binding.revisionRef||entry.version!==current.binding.version||entry.checksum!==current.binding.checksum
    ||entry.installDir!==current.binding.rootPath)return false;
  const omit=(entry:Record<string,unknown>)=>Object.fromEntries(Object.entries(entry).filter(([key])=>key!==field));
  return canonicalRecord(omit(before))===canonicalRecord(omit(after));
}

export type CapabilityPackagePublishContext = { authorization: AuthorizedCapabilityPackageResource; draft: CapabilityPackageDraft;
  state: CapabilityPackageState | null; revisionRef: string };
export async function publishCapabilityPackageDraft(actorInput: CapabilityResourceActor, requestInput: CapabilityPackagePublishRequest,
  callback: (context: CapabilityPackagePublishContext, database: SqlConnection) => Promise<CapabilityPackagePublicationResult>): Promise<{ state: CapabilityPackageState; published: CapabilityPackagePublishedRevision }> {
  const actor = actorSnapshot(actorInput), request = structuredClone(requestInput);
  const replay = await findCapabilityPackagePublicationReplay(actor,request);
  if (replay) return replay;
  try {
  const row = await usingDatabase(undefined, async db => db.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[text(request.draftRef,'Draft reference'),actor.userId])) as Row | undefined;
  if (!row) fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
  const stored = mapDraft(row);
  return await withDraftAuthorization(actor,stored,async (initial,database) => {
    await lockOperationRequest(database,actor,request.requestId);
    const requestHash = publicationRequestHash(request);
    if (request.requestId) await operationForRequest(database,actor,request.requestId,requestHash);
    const locked = await database.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2 FOR UPDATE',[request.draftRef,actor.userId]) as Row | undefined;
    if (!locked) fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
    const { draft } = mapDraft(locked);
    if (draft.draftRevision !== revision(request.expectedDraftRevision)) fail('PACKAGE_DRAFT_CONFLICT','The package draft changed. Validate it again.',409);
    const publish = async (authorization: AuthorizedCapabilityPackageResource) => {
      if (authorization.record.metadata.resourceRef !== draft.resourceRef
        || authorization.record.metadata.metadataRevision !== request.expectedMetadataRevision
        || authorization.record.metadata.grantsRevision !== request.expectedGrantsRevision) fail('PACKAGE_REVISION_CONFLICT','Package metadata or grants changed. Reload before publishing.',409);
      const state = await getCapabilityPackageState(draft.resourceRef,database);
      assertHead(state,request);
      if (draft.basePackageRevision !== request.expectedPackageRevision || draft.basePublishedRevisionRef !== request.expectedPublishedRevisionRef) fail('PACKAGE_REVISION_CONFLICT','The draft is based on another package revision.',409);
      if (draft.operation === 'edit') assertCurrentSource(state,draft.baseSourceStamp);
      const revisionRef = `canvas-package-revision:${randomUUID()}`;
      const baseOrigin = draft.baseSourceStamp ? normalizeCapabilityStoreOrigin(draft.baseSourceStamp.storeOrigin, draft.baseSourceStamp.resourceId) ?? undefined : undefined;
      const publishedOrigin = draft.operation === 'fork' ? deriveCapabilityStoreOrigin(baseOrigin, authorization.record.storage.resourceId) : baseOrigin;
      const expectedOrigin = publishedOrigin ? Object.freeze(publishedOrigin) : undefined;
      const heldDraft = Object.freeze(structuredClone(draft));
      const prepared = await originPreparations.run({ authorization, expectedOrigin, database, revisionRef },
        () => callback({authorization,draft:heldDraft,state,revisionRef},database));
      const result = await commitCapabilityPackagePublication(authorization, database, state, revisionRef, prepared, expectedOrigin,
        draft.operation === 'create' ? null : { resourceRef: draft.sourceResourceRef, revisionRef: draft.sourcePublishedRevisionRef, stamp: draft.baseSourceStamp });
      await recordPackageOperation(database,actor,{requestId:request.requestId,requestHash,operation:'publish',status:'published',draft,
        targetStorage:stored.targetStorage,publishedRevisionRef:revisionRef,result});
      await database.run("UPDATE capability_package_operations SET status='published',draft_revision=$1,published_revision_ref=$2,updated_at=$3 WHERE actor_user_id=$4 AND draft_ref=$5 AND operation='create'", [draft.draftRevision,revisionRef,Date.now(),actor.userId,draft.draftRef]);
      await database.run('DELETE FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[draft.draftRef,actor.userId]);
      return result;
    };
    if (draft.operation === 'fork' || draft.operation === 'create') {
      const created = await createCapabilityPackageTargetOnConnection(initial,draft.resourceRef,database);
      // New target has no inherited grants. Its first public resource revisions are one, not zero.
      const expected = request.expectedMetadataRevision === 0 && request.expectedGrantsRevision === 0
        ? {...request,expectedMetadataRevision:1,expectedGrantsRevision:1} : request;
      request.expectedMetadataRevision=expected.expectedMetadataRevision; request.expectedGrantsRevision=expected.expectedGrantsRevision;
      return withAuthorizedCapabilityPackageResource(actor,created.storage,'publish',expected,publish,{database});
    }
    return withAuthorizedCapabilityPackageResource(actor,stored.targetStorage,'publish',request,publish,{database});
  });
  } catch (error) {
    if (error instanceof CapabilityPackageError && ['PACKAGE_NOT_FOUND','PACKAGE_NAMESPACE_CONFLICT','PACKAGE_REVISION_CONFLICT','PACKAGE_DRAFT_CONFLICT'].includes(error.code)) {
      const completed = await findCapabilityPackagePublicationReplay(actor,requestInput);
      if (completed) return completed;
    }
    throw error;
  }
}

async function commitCapabilityPackagePublication(authorization: AuthorizedCapabilityPackageResource, database: SqlConnection,
  state: CapabilityPackageState | null, revisionRef: string, prepared: CapabilityPackagePublicationResult,
  expectedOrigin: CapabilityStoreOrigin | undefined, provenance: { resourceRef: string; revisionRef: string | null; stamp: CapabilityPackageSourceStamp } | null,
): Promise<{ state: CapabilityPackageState; published: CapabilityPackagePublishedRevision }> {
  if (!isHeldCapabilityPackageResource(authorization, database)) fail('PACKAGE_ACCESS_DENIED', 'A held publication is required.', 403);
  const storage = authorization.record.storage, resourceRef = authorization.record.metadata.resourceRef;
  const { snapshot } = prepared, validation = snapshot.validation, sourceStamp = stampSnapshot(prepared.sourceStamp);
  if (!validation.valid || validation.kind !== storage.resourceType || validation.name !== storage.name || !validation.version || !validation.checksum
    || snapshot.location.resourceRef !== resourceRef || snapshot.location.revisionRef !== revisionRef || snapshot.location.name !== storage.name
    || snapshot.location.kind !== storage.resourceType || snapshot.location.version !== validation.version || snapshot.location.checksum !== validation.checksum
    || snapshot.marker.contractVersion !== CAPABILITY_PACKAGE_CONTRACT_VERSION || snapshot.marker.resourceRef !== resourceRef || snapshot.marker.revisionRef !== revisionRef
    || snapshot.marker.checksum !== validation.checksum || sourceStamp.resourceId !== authorization.record.storage.resourceId || sourceStamp.kind !== storage.resourceType
    || sourceStamp.name !== storage.name || sourceStamp.version !== validation.version || sourceStamp.checksum !== validation.checksum
    || sourceStamp.registryChecksum !== validation.checksum || !sameCapabilityStoreOrigin(sourceStamp.storeOrigin, expectedOrigin)
    || validation.files.length > CAPABILITY_PACKAGE_LIMITS.maxFiles
    || validation.totalBytes > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes) fail('PACKAGE_INVALID','The prepared snapshot does not match this publication.');
  const now = Date.now();
  const published: CapabilityPackagePublishedRevision = { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION,resourceRef:resourceRef,revisionRef,
    kind:storage.resourceType,name:storage.name,version:validation.version,checksum:validation.checksum,files:structuredClone(validation.files),totalBytes:validation.totalBytes,
    publishedByUserId:authorization.actor.userId,publishedAt:now,baseRevisionRef:state?.currentPublishedRevisionRef ?? null,
    sourceResourceRef:provenance?.resourceRef ?? null,sourceRevisionRef:provenance?.revisionRef ?? null,sourceChecksum:provenance?.stamp.checksum ?? null,sourceStamp:provenance ? structuredClone(provenance.stamp) : null };
  await database.run(`INSERT INTO capability_package_versions (revision_ref,resource_ref,kind,name,version,checksum,files,total_bytes,published_by_user_id,published_at,base_revision_ref,source_resource_ref,source_revision_ref,source_checksum,source_stamp)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[revisionRef,resourceRef,storage.resourceType,storage.name,published.version,published.checksum,JSON.stringify(published.files),published.totalBytes,authorization.actor.userId,now,published.baseRevisionRef,published.sourceResourceRef,published.sourceRevisionRef,published.sourceChecksum,published.sourceStamp ? JSON.stringify(published.sourceStamp) : null]);
  const next: CapabilityPackageState = {contractVersion:CAPABILITY_PACKAGE_CONTRACT_VERSION,resourceRef:resourceRef,kind:storage.resourceType,name:storage.name,
    packageRevision:(state?.packageRevision ?? 0)+1,currentPublishedRevisionRef:revisionRef,currentSourceStamp:sourceStamp,updatedByUserId:authorization.actor.userId,updatedAt:now};
  await database.run(`INSERT INTO capability_package_states (resource_ref,kind,name,package_revision,current_published_revision_ref,current_source_stamp,updated_by_user_id,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (resource_ref) DO UPDATE SET package_revision=EXCLUDED.package_revision,
    current_published_revision_ref=EXCLUDED.current_published_revision_ref,current_source_stamp=EXCLUDED.current_source_stamp,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`,
  [next.resourceRef,next.kind,next.name,next.packageRevision,revisionRef,JSON.stringify(sourceStamp),authorization.actor.userId,now]);
  return { state: next, published };
}

export type CapabilityStorePublicationContext = {
  authorization: AuthorizedCapabilityPackageResource; state: CapabilityPackageState | null; revisionRef: string;
  version: string; checksum: string; storeOrigin: CapabilityStoreOrigin; legacyHistory: boolean; newResource: boolean;
  validation?: import('./contracts').CapabilityPackageValidation;
};
export type CapabilityStorePublicationInput = {
  storage: CapabilityResourceStorageBinding; prepared: PreparedCapabilityStorePackage;
} & ({ operation: 'install'; ownership: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>;
  resourceRef: string; grants: CapabilityResourceGrantInput[]; responsibleUserId?: string | null;
} | { operation: 'update'; resourceRef: string; request: CapabilityPackageStoreUpdateRequest;
  currentSource: { rootPath: string; stamp: CapabilityPackageSourceStamp }; legacyHistory?: PreparedLegacyCapabilityStoreHistory; });

/** IO cannot accept a caller's source path: the exact source belongs to this held SQL preparation. */
export function getHeldCapabilityStorePublicationSource(authorization: AuthorizedCapabilityPackageResource,
  database: SqlConnection, revisionRef: string): Readonly<{ rootPath: string; checksum: string }> {
  const current = originPreparations.getStore();
  if (!current || !current.source || current.authorization !== authorization || current.database !== database
    || current.revisionRef !== revisionRef || !isHeldCapabilityPackageResource(authorization, database)) {
    fail('PACKAGE_ACCESS_DENIED', 'A held Store publication source is required.', 403);
  }
  return Object.freeze({ ...current.source });
}

/** Current authority and all content/permission revisions remain held through the immutable publication. */
export async function publishCapabilityPackageFromStore(actorInput: CapabilityResourceActor, input: CapabilityStorePublicationInput,
  callback: (context: CapabilityStorePublicationContext, database: SqlConnection) => Promise<CapabilityPackagePublicationResult>,
): Promise<{ state: CapabilityPackageState; published: CapabilityPackagePublishedRevision }> {
  const actor = actorSnapshot(actorInput), storage = Object.freeze(structuredClone(input.storage));
  const preparedSource = getPreparedCapabilityStorePackage(input.prepared);
  if (storage.sourceType !== 'standalone' || storage.scopeType === 'system' || storage.sourcePluginId !== null
    || preparedSource.resourceId !== storage.resourceId || preparedSource.kind !== storage.resourceType || preparedSource.entryKey !== storage.name) {
    fail('PACKAGE_ACCESS_DENIED', 'The Store package is not bound to this target.', 403);
  }
  const captured = input.operation === 'install' ? { ...input, prepared: input.prepared,
    ownership: structuredClone(input.ownership), grants: structuredClone(input.grants) }
    : { ...input, prepared: input.prepared, request: structuredClone(input.request), currentSource: structuredClone(input.currentSource) };
  const sourceOrigin = normalizeCapabilityStoreOrigin(preparedSource.storeOrigin, storage.resourceId);
  if (!sourceOrigin) fail('PACKAGE_ACCESS_DENIED', 'The Store package origin is unavailable.', 403);
  const publish = async (authorization: AuthorizedCapabilityPackageResource, database: SqlConnection) => {
    if (!authorization.access.canManage || !authorization.access.canEdit) {
      fail('PACKAGE_ACCESS_DENIED', 'Store publication requires both management and editing permission.', 403);
    }
    await assertPreparedCapabilityStorePackage(captured.prepared, { kind: preparedSource.kind, registryId: preparedSource.registryId,
      entryKey: preparedSource.entryKey, version: preparedSource.version, checksum: preparedSource.upstreamChecksum,
      resourceId: storage.resourceId }, { database });
    let state = await getCapabilityPackageState(authorization.record.metadata.resourceRef, database);
    if (captured.operation === 'update') {
      assertHead(state, captured.request);
      if (captured.currentSource.stamp.checksum !== captured.request.expectedLocalChecksum) {
        fail('PACKAGE_SOURCE_CHANGED', 'The installed package changed after its update was reviewed.', 409);
      }
      const { readExactPackageInventory } = await import('./io');
      if ((await readExactPackageInventory(captured.currentSource.rootPath)).checksum !== captured.request.expectedLocalChecksum) {
        fail('PACKAGE_SOURCE_CHANGED', 'The installed package bytes changed after review.', 409);
      }
      // Default activation can advance the registry revision without changing immutable content.
      assertCurrentSource(state, state ? { ...captured.currentSource.stamp,
        artifactRevision: state.currentSourceStamp.artifactRevision } : captured.currentSource.stamp);
    } else assertHead(state, { expectedPackageRevision: 0, expectedPublishedRevisionRef: null });
    const prepare = async (rootPath: string, checksum: string, version: string, origin: CapabilityStoreOrigin,
      legacyHistory: boolean, provenance: { resourceRef: string; revisionRef: string | null; stamp: CapabilityPackageSourceStamp },
      validation?: import('./contracts').CapabilityPackageValidation) => {
      const revisionRef = `canvas-package-revision:${randomUUID()}`;
      const expectedOrigin = Object.freeze(origin);
      const result = await originPreparations.run({ authorization, database, revisionRef, expectedOrigin,
        source: Object.freeze({ rootPath, checksum }) }, () => callback({ authorization, state, revisionRef, version,
        checksum, storeOrigin: expectedOrigin, legacyHistory, newResource: captured.operation === 'install', validation }, database));
      return commitCapabilityPackagePublication(authorization, database, state, revisionRef, result, expectedOrigin, provenance);
    };
    if (captured.operation === 'update' && !state) {
      const oldOrigin = normalizeCapabilityStoreOrigin(captured.currentSource.stamp.storeOrigin, storage.resourceId);
      if (!oldOrigin || oldOrigin.relation !== 'installed') fail('PACKAGE_SOURCE_CHANGED', 'The current Store origin is not verifiable.', 409);
      if (!captured.legacyHistory) fail('PACKAGE_ACCESS_DENIED', 'A verified legacy history capture is required.', 403);
      const legacy = await readHeldLegacyCapabilityStoreHistory(captured.legacyHistory, authorization, database);
      const historical = await prepare(legacy.rootPath, legacy.checksum,
        captured.currentSource.stamp.version, oldOrigin, true, { resourceRef: authorization.record.metadata.resourceRef,
          revisionRef: null, stamp: captured.currentSource.stamp }, legacy.validation);
      state = historical.state;
    }
    const upstreamStamp: CapabilityPackageSourceStamp = { resourceId: storage.resourceId, kind: storage.resourceType,
      name: storage.name, version: preparedSource.version, artifactRevision: null, registryChecksum: preparedSource.upstreamChecksum,
      checksum: preparedSource.baselineChecksum, sourcePluginId: null, storeOrigin: sourceOrigin };
    return prepare(preparedSource.packageRoot, preparedSource.baselineChecksum, preparedSource.version, sourceOrigin, false,
      { resourceRef: authorization.record.metadata.resourceRef, revisionRef: state?.currentPublishedRevisionRef ?? null,
        stamp: captured.operation === 'update' ? state!.currentSourceStamp : upstreamStamp });
  };
  if (captured.operation === 'install') {
    return withAuthorizedCapabilityPackageTarget(actor, storage, captured.ownership, async (initial, database) => {
      await createCapabilityPackageTargetOnConnection(initial, captured.resourceRef, database,
        { grants: captured.grants, responsibleUserId: captured.responsibleUserId });
      return withAuthorizedCapabilityPackageResource(actor, storage, 'publish', { expectedMetadataRevision: 1, expectedGrantsRevision: 1 }, publish, { database });
    });
  }
  return withAuthorizedCapabilityPackageResource(actor, storage, 'publish', captured.request, async (initial, database) => {
    if (!initial.access.canManage || !initial.access.canEdit) fail('PACKAGE_ACCESS_DENIED', 'Store update requires management and editing permission.', 403);
    if (initial.record.metadata.resourceRef !== captured.resourceRef) fail('PACKAGE_SOURCE_CHANGED', 'The selected installed resource changed.', 409);
    if (initial.record.metadata.metadataRevision !== 0) return publish(initial, database);
    const resourceRef = `canvas-resource:${randomUUID()}`;
    await createCapabilityPackageTargetOnConnection(initial, resourceRef, database, { preserveBaselineAccessMode: true });
    return withAuthorizedCapabilityPackageResource(actor, storage, 'publish', { expectedMetadataRevision: 1, expectedGrantsRevision: 1 }, publish, { database });
  });
}
