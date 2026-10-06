import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openDb, type SqlConnection } from '@/app/lib/db';
import {resolveOrganizationDataRoot,resolveUserDataRoot} from '@/app/lib/runtime-data-paths';
import type { CapabilityResourceActor, CapabilityResourceOwnerScope, CapabilityResourceStorageBinding } from '../resources/contracts';
import { authority } from '../scope-authority';
import { createCapabilityPackageTargetOnConnection, isAuthorizedCapabilityPackageResource, isHeldCapabilityPackageResource,
  withAuthorizedCapabilityPackageResource, withAuthorizedCapabilityPackageTarget } from '../resources/store';
import { CAPABILITY_PACKAGE_CONTRACT_VERSION, CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError,
  type AuthorizedCapabilityPackageResource, type CapabilityPackageDraft, type CapabilityPackageDraftCreation,
  type CapabilityPackageDraftSeed, type CapabilityPackageExpectedHead, type CapabilityPackagePublicationResult,
  type CapabilityPackagePublishedRevision, type CapabilityPackagePublishRequest, type CapabilityPackageSourceStamp,
  type CapabilityPackageState, type CapabilityPackagePublishedSummary } from './contracts';

type Row = Record<string, unknown>;
export type CapabilityPackageDraftRecord = { draft: CapabilityPackageDraft; targetStorage: CapabilityResourceStorageBinding;
  targetOwnership: Exclude<CapabilityResourceOwnerScope, { type: 'system' }>;
  sourceStorage: CapabilityResourceStorageBinding; sourceParentStorage?: CapabilityResourceStorageBinding };
type PrivateDraft = CapabilityPackageDraftRecord;
export type CapabilityPackagePublicationBinding = { revisionRef: string; version: string; checksum: string; rootPath: string };
type Publication = { authorization: AuthorizedCapabilityPackageResource; binding: CapabilityPackagePublicationBinding; database: SqlConnection };
const publicationKey = Symbol.for('canvas.capability.package-publication.v1');
const publicationGlobal = globalThis as typeof globalThis & { [publicationKey]?: AsyncLocalStorage<Publication> };
const publications = publicationGlobal[publicationKey] ??= new AsyncLocalStorage<Publication>();
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
    sourceResourceRef:String(row.source_resource_ref),sourceRevisionRef:row.source_revision_ref==null?null:String(row.source_revision_ref),sourceChecksum:String(row.source_checksum),sourceStamp:json(row.source_stamp) };
}
function mapDraft(row: Row): PrivateDraft {
  return { draft: { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION, draftRef: String(row.draft_ref), resourceRef: String(row.resource_ref),
    kind: row.kind as CapabilityPackageDraft['kind'], name: String(row.name), operation: row.operation as CapabilityPackageDraft['operation'], actorUserId: String(row.actor_user_id),
    draftRevision: Number(row.draft_revision), basePackageRevision: Number(row.base_package_revision), basePublishedRevisionRef: row.base_published_revision_ref == null ? null : String(row.base_published_revision_ref),
    baseSourceStamp: json(row.base_source_stamp), sourceResourceRef: String(row.source_resource_ref), sourceMetadataRevision: Number(row.source_metadata_revision),
    sourceGrantsRevision: Number(row.source_grants_revision),sourcePackageRevision:Number(row.source_package_revision),
    sourcePublishedRevisionRef:row.source_published_revision_ref==null?null:String(row.source_published_revision_ref), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) },
    targetStorage: json(row.target_storage), targetOwnership: json(row.target_ownership), sourceStorage: json(row.source_storage),
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
  if (state && canonical(state.currentSourceStamp) !== canonical(stamp)) fail('PACKAGE_SOURCE_CHANGED', 'The installed package pointer changed.', 409);
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
export async function assertCapabilityPackageCommittedReference(input: { resourceRef: string; revisionRef: string; version: string; checksum: string }): Promise<void> {
  const state = await getCapabilityPackageState(input.resourceRef);
  const published = state ? await getCapabilityPackagePublishedRevision(input.resourceRef, state.currentPublishedRevisionRef) : null;
  if (!state || state.currentPublishedRevisionRef !== input.revisionRef || !published || published.version !== input.version || published.checksum !== input.checksum) {
    fail('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The installed package publication is unavailable.', 503);
  }
}

export async function getCapabilityPackageDraft(actorInput: CapabilityResourceActor, draftRef: string): Promise<CapabilityPackageDraft> {
  return (await getCapabilityPackageDraftRecord(actorInput,draftRef)).draft;
}

/** Creator-only recovery metadata grants no source bytes, edit rights or filesystem receipt. */
export async function getCapabilityPackageOwnedDraftStatus(actorInput:CapabilityResourceActor,draftRef:string):Promise<{
  draftRef:string;resourceRef:string;kind:CapabilityPackageDraft['kind'];name:string;draftRevision:number;
  operation:CapabilityPackageDraft['operation'];targetOwnership:CapabilityResourceOwnerScope;
}> {
  const actor=actorSnapshot(actorInput),ref=text(draftRef,'Draft reference');
  return usingDatabase(undefined,async database=>{
    const current=await authority(database,actor);
    if(!current.valid||!current.contextValid)fail('PACKAGE_ACCESS_DENIED','An active actor and workspace are required.',403);
    const row=await database.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[ref,actor.userId]) as Row|undefined;
    if(!row)fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
    const stored=mapDraft(row),draft=stored.draft;
    return {draftRef:draft.draftRef,resourceRef:draft.resourceRef,kind:draft.kind,name:draft.name,draftRevision:draft.draftRevision,
      operation:draft.operation,targetOwnership:structuredClone(stored.targetOwnership)};
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
  return withAuthorizedCapabilityPackageTarget(actor, stored.targetStorage, stored.targetOwnership, async (target, database) =>
    withAuthorizedCapabilityPackageResource(actor, stored.sourceStorage, 'read', undefined, async () => callback(target, database),
      { parentStorage: stored.sourceParentStorage, database }));
}

export async function beginCapabilityPackageDraft(actorInput: CapabilityResourceActor, input: CapabilityPackageDraftCreation,
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
  return publications.run({authorization,binding,database},callback);
}
export function isCapabilityPackagePublicationAllowed(storage: CapabilityResourceStorageBinding,
  next?: {version:string;checksum:string;installDir?:string}): boolean {
  const current = publications.getStore();
  return Boolean(current && isHeldCapabilityPackageResource(current.authorization,current.database)
    && sameStorage(current.authorization.record.storage,storage)
    && (!next || next.version === current.binding.version && next.checksum === current.binding.checksum
      && (!next.installDir || path.resolve(next.installDir) === path.resolve(current.binding.rootPath))));
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
  const row = await usingDatabase(undefined, async db => db.get('SELECT * FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[text(request.draftRef,'Draft reference'),actor.userId])) as Row | undefined;
  if (!row) fail('PACKAGE_NOT_FOUND','The package draft was not found.',404);
  const stored = mapDraft(row);
  return withDraftAuthorization(actor,stored,async (initial,database) => {
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
      const prepared = await callback({authorization,draft:Object.freeze(structuredClone(draft)),state,revisionRef},database);
      const { snapshot } = prepared, validation = snapshot.validation, sourceStamp = stampSnapshot(prepared.sourceStamp);
      if (!validation.valid || validation.kind !== draft.kind || validation.name !== draft.name || !validation.version || !validation.checksum
        || snapshot.location.resourceRef !== draft.resourceRef || snapshot.location.revisionRef !== revisionRef || snapshot.location.name !== draft.name
        || snapshot.location.kind !== draft.kind || snapshot.location.version !== validation.version || snapshot.location.checksum !== validation.checksum
        || snapshot.marker.contractVersion !== CAPABILITY_PACKAGE_CONTRACT_VERSION || snapshot.marker.resourceRef !== draft.resourceRef || snapshot.marker.revisionRef !== revisionRef
        || snapshot.marker.checksum !== validation.checksum || sourceStamp.resourceId !== authorization.record.storage.resourceId || sourceStamp.kind !== draft.kind
        || sourceStamp.name !== draft.name || sourceStamp.version !== validation.version || sourceStamp.checksum !== validation.checksum
        || sourceStamp.registryChecksum !== validation.checksum || validation.files.length > CAPABILITY_PACKAGE_LIMITS.maxFiles
        || validation.totalBytes > CAPABILITY_PACKAGE_LIMITS.maxTotalBytes) fail('PACKAGE_INVALID','The prepared snapshot does not match this publication.');
      const now = Date.now();
      const published: CapabilityPackagePublishedRevision = { contractVersion: CAPABILITY_PACKAGE_CONTRACT_VERSION,resourceRef:draft.resourceRef,revisionRef,
        kind:draft.kind,name:draft.name,version:validation.version,checksum:validation.checksum,files:structuredClone(validation.files),totalBytes:validation.totalBytes,
        publishedByUserId:actor.userId,publishedAt:now,baseRevisionRef:state?.currentPublishedRevisionRef ?? null,
        sourceResourceRef:draft.sourceResourceRef,sourceRevisionRef:draft.sourcePublishedRevisionRef,sourceChecksum:draft.baseSourceStamp.checksum,sourceStamp:structuredClone(draft.baseSourceStamp) };
      await database.run(`INSERT INTO capability_package_versions (revision_ref,resource_ref,kind,name,version,checksum,files,total_bytes,published_by_user_id,published_at,base_revision_ref,source_resource_ref,source_revision_ref,source_checksum,source_stamp)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[revisionRef,draft.resourceRef,draft.kind,draft.name,published.version,published.checksum,JSON.stringify(published.files),published.totalBytes,actor.userId,now,published.baseRevisionRef,published.sourceResourceRef,published.sourceRevisionRef,published.sourceChecksum,JSON.stringify(published.sourceStamp)]);
      const next: CapabilityPackageState = {contractVersion:CAPABILITY_PACKAGE_CONTRACT_VERSION,resourceRef:draft.resourceRef,kind:draft.kind,name:draft.name,
        packageRevision:(state?.packageRevision ?? 0)+1,currentPublishedRevisionRef:revisionRef,currentSourceStamp:sourceStamp,updatedByUserId:actor.userId,updatedAt:now};
      await database.run(`INSERT INTO capability_package_states (resource_ref,kind,name,package_revision,current_published_revision_ref,current_source_stamp,updated_by_user_id,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (resource_ref) DO UPDATE SET package_revision=EXCLUDED.package_revision,
        current_published_revision_ref=EXCLUDED.current_published_revision_ref,current_source_stamp=EXCLUDED.current_source_stamp,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`,
      [next.resourceRef,next.kind,next.name,next.packageRevision,revisionRef,JSON.stringify(sourceStamp),actor.userId,now]);
      await database.run('DELETE FROM capability_package_drafts WHERE draft_ref=$1 AND actor_user_id=$2',[draft.draftRef,actor.userId]);
      return {state:next,published};
    };
    if (draft.operation === 'fork') {
      const created = await createCapabilityPackageTargetOnConnection(initial,draft.resourceRef,database);
      // New target has no inherited grants. Its first public resource revisions are one, not zero.
      const expected = request.expectedMetadataRevision === 0 && request.expectedGrantsRevision === 0
        ? {...request,expectedMetadataRevision:1,expectedGrantsRevision:1} : request;
      request.expectedMetadataRevision=expected.expectedMetadataRevision; request.expectedGrantsRevision=expected.expectedGrantsRevision;
      return withAuthorizedCapabilityPackageResource(actor,created.storage,'publish',expected,publish,{database});
    }
    return withAuthorizedCapabilityPackageResource(actor,stored.targetStorage,'publish',request,publish,{database});
  });
}
