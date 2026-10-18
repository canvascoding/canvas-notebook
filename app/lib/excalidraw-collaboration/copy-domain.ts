import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import type { SqlConnection } from '../db';
import type { NativeCopyReceipt } from '../collaboration/native-copy-persistence';
import type { WorkspaceOperationManagedCopyStageV4 } from '../files/workspace-operation-managed-copy-stage';
import { assertNativeCopySessionOnConnection } from '../files/workspace-operation-native-copy-owner';
import { assertNativeCopyManagedScenePreparationOnConnection, assertNativeCopyManagedSceneCompletionOnConnection,
  type NativeCopyPhasePathReceipt } from '../files/workspace-operation-native-copy-phase';
import { nativeCopyPhaseReceiptProof, captureNativeCopyPhaseStage } from '../files/workspace-operation-native-copy-phase-contract';
import { lockFileCollaborationPaths } from '../files/collaboration-repository';
import { preparedWorkspacePathCopyProof } from '../filesystem/prepared-workspace-path-copy-contract';
import { canonicalSceneHash } from './scene';
import { assertPublishedExcalidrawCopyAssets } from './copy-asset-publication';
import { copyCapture, copyDigest, copyFreeze, copyHash, copyInteger, copyInvalid,
  captureExcalidrawCopyAssetOriginal, captureExcalidrawCopyAssetReceipt, captureExcalidrawCopyIntent,
  captureExcalidrawCopyBirthReceipt } from './copy-data';
import type { ExcalidrawCopyAssetOriginal, ExcalidrawCopyAssetReceipt, ExcalidrawCopyIntent, ExcalidrawCopyBirthReceipt } from './copy-contract';
export type { ExcalidrawCopyIntent, ExcalidrawCopyBirthReceipt, ExcalidrawCopyReceiptStorageIdentity } from './copy-contract';
export { readHistoricalExcalidrawCopyOnConnection, readExcalidrawCopyReceiptStorageIdentityOnConnection } from './copy-history';

type Row = Record<string, unknown>;
type Ledger = Readonly<{ intent: ExcalidrawCopyIntent; receipt: ExcalidrawCopyBirthReceipt | null }>;
function changed(): never { return copyInvalid('EXCALIDRAW_COPY_CHANGED'); }
function conflict(): never { return copyInvalid('EXCALIDRAW_COPY_ASSET_CONFLICT'); }
const TABLE = 'collaboration_excalidraw_copy_receipts';
function checkedStage(stage: WorkspaceOperationManagedCopyStageV4): void {
  if (stage.version !== 4 || captureNativeCopyPhaseStage(stage).payloadSha256 !== stage.payloadSha256) changed();
}
function bind(intent: ExcalidrawCopyIntent, stage: WorkspaceOperationManagedCopyStageV4): void {
  if (intent.operationId !== stage.identity.operationId || intent.stageDigest !== stage.payloadSha256
    || intent.requestHash !== stage.identity.canonicalRequestHash || !equal(intent.origin, stage.origin)
    || !equal(intent.assetOriginal.destinationScope, stage.origin.destinationScope)
    || !equal(intent.documents.map(({ documentId: _documentId, lineageId: _lineageId, ...requirement }) => requirement), stage.plan.sceneCopyRequirements)) changed();
  const expected = new Map<string, unknown>();
  for (const row of stage.sceneAssets) { const prior = expected.get(row.asset.metadata.fileId);
    if (prior && !equal(prior, row.asset.metadata)) conflict(); expected.set(row.asset.metadata.fileId, row.asset.metadata); }
  if (!equal(intent.assetOriginal.metadata, [...expected.values()].sort((a, b) => (a as { fileId: string }).fileId.localeCompare((b as { fileId: string }).fileId)))) changed();
}
async function xid(database: SqlConnection): Promise<string> {
  const row = await database.get(`SELECT pg_catalog.pg_current_xact_id()::text AS xid,
    pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('session_replication_role') AS replication`) as Row | undefined;
  if (!row || row.isolation !== 'read committed' || row.read_only !== 'off' || row.replication !== 'origin'
    || typeof row.xid !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(row.xid)) copyInvalid('EXCALIDRAW_COPY_TRANSACTION_CHANGED');
  return row.xid;
}
async function nativeLedger(database: SqlConnection, stage: WorkspaceOperationManagedCopyStageV4, receipt?: NativeCopyReceipt): Promise<Row> {
  const row = await database.get(`SELECT workspace_id,operation_id,version,kind,actor_user_id,actor_session_id,organization_id,
    request_fingerprint,publication_fingerprint,publication_status,xmin::text AS xmin,created_at,
    CASE WHEN octet_length(private_result::text)<=16777216 THEN private_result END AS private_result
    FROM collaboration_native_copy_receipts WHERE workspace_id=$1 AND operation_id=$2`,
  [stage.identity.destinationWorkspaceId, stage.identity.operationId]) as Row | undefined;
  if (!row || row.version !== 1 || row.kind !== 'native_clone' || row.actor_user_id !== stage.origin.actor.userId
    || row.actor_session_id !== stage.origin.actor.sessionId || row.organization_id !== stage.origin.destinationScope.organizationId
    || row.publication_fingerprint !== stage.payloadSha256 || !copyHash(row.request_fingerprint)
    || !['native_committed', 'published'].includes(String(row.publication_status)) || !row.private_result) changed();
  if (receipt && (receipt.operationId !== row.operation_id || receipt.workspaceId !== row.workspace_id
    || receipt.requestFingerprint !== row.request_fingerprint
    || nativeCopyPhaseReceiptProof(receipt) !== copyDigest(row.private_result))) changed();
  return row;
}
/** Same original Owner/B only. This never calls a prepare grant or current
 * document/asset reader; it is safe before deciding prepared versus recovered. */
export async function readOriginalExcalidrawCopyOnConnection(database: SqlConnection,
  { stage }: Readonly<{ stage: WorkspaceOperationManagedCopyStageV4 }>): Promise<Ledger | null> {
  checkedStage(stage); await assertNativeCopySessionOnConnection(database, stage.origin);
  const header = await database.get(`SELECT version,stage_digest,request_hash,native_request_fingerprint,intent_digest,
    b1_transaction_id,created_at,birth_digest,b2_transaction_id,completed_at,
    octet_length(intent_json::text) AS intent_bytes,octet_length(birth_json::text) AS birth_bytes
    FROM ${TABLE} WHERE workspace_id=$1 AND operation_id=$2`, [stage.identity.destinationWorkspaceId, stage.identity.operationId]) as Row | undefined;
  if (!header) return null;
  if (header.version !== 1 || header.stage_digest !== stage.payloadSha256 || header.request_hash !== stage.identity.canonicalRequestHash
    || !copyInteger(Number(header.intent_bytes), 1) || Number(header.intent_bytes) > 16 * 1024 * 1024
    || header.birth_bytes !== null && (!copyInteger(Number(header.birth_bytes), 1) || Number(header.birth_bytes) > 32 * 1024 * 1024)) changed();
  const body = await database.get(`SELECT intent_json,birth_json FROM ${TABLE} WHERE workspace_id=$1 AND operation_id=$2
    AND octet_length(intent_json::text)<=16777216 AND (birth_json IS NULL OR octet_length(birth_json::text)<=33554432)`,
  [stage.identity.destinationWorkspaceId, stage.identity.operationId]) as Row | undefined;
  if (!body) changed();
  const intent = captureExcalidrawCopyIntent(body.intent_json), receipt = body.birth_json === null ? null : captureExcalidrawCopyBirthReceipt(body.birth_json);
  bind(intent, stage);
  if (intent.intentDigest !== header.intent_digest || intent.nativeRequestFingerprint !== header.native_request_fingerprint
    || intent.b1TransactionId !== header.b1_transaction_id || intent.createdAt !== Number(header.created_at)
    || receipt && (!equal(receipt.intent, intent) || receipt.receiptProof !== header.birth_digest || receipt.b2TransactionId !== header.b2_transaction_id
      || !copyInteger(Number(header.completed_at), 1) || receipt.documents.some(document => document.persistedAt !== Number(header.completed_at)))
    || !receipt && [header.birth_digest, header.b2_transaction_id, header.completed_at].some(value => value !== null)) changed();
  const native = await nativeLedger(database, stage);
  if (native.request_fingerprint !== intent.nativeRequestFingerprint || copyDigest(native.private_result) !== intent.nativeReceiptProof) changed();
  await assertNativeCopySessionOnConnection(database, stage.origin); checkedStage(stage);
  return copyFreeze({ intent, receipt });
}
async function lockScenes(database: SqlConnection, stage: WorkspaceOperationManagedCopyStageV4, intent?: ExcalidrawCopyIntent): Promise<void> {
  const ids = new Set([...stage.plan.sceneCopyRequirements.map(row => row.sourceDocumentId), ...(intent?.documents.map(row => row.documentId) ?? [])]);
  for (const id of [...ids].sort()) await database.get('SELECT pg_advisory_xact_lock(hashtext($1))', [`excalidraw:${id}`]);
  await lockFileCollaborationPaths(database, stage.origin.destinationScope.workspaceId, stage.plan.sceneCopyRequirements.map(row => row.destinationPath));
}
async function currentSources(database: SqlConnection, stage: WorkspaceOperationManagedCopyStageV4): Promise<void> {
  let remaining = 128 * 1024 * 1024;
  for (const requirement of stage.plan.sceneCopyRequirements) {
    const source = stage.sceneRecords.find(row => row.header.id === requirement.sourceDocumentId); if (!source) changed();
    const row = await database.get(`SELECT d.id,d.lineage_id,d.workspace_id,d.workspace_type,d.organization_id,d.customer_id,d.project_id,d.path,d.provider,d.status,
      l.id AS lineage_id_actual,l.workspace_id AS lineage_workspace_id,l.workspace_type AS lineage_workspace_type,l.path AS lineage_path,l.status AS lineage_status,
      l.organization_id AS lineage_organization_id,l.customer_id AS lineage_customer_id,l.project_id AS lineage_project_id,l.archived_at,l.trash_entry_id,
      s.document_id,s.workspace_id AS scene_workspace_id,s.organization_id AS scene_organization_id,s.path AS scene_path,s.status AS scene_status,
      s.lifecycle_generation,s.scene_sequence,s.canonical_hash,s.excalidraw_version,s.scene_schema_version,
      octet_length(s.elements_json::text)+octet_length(s.shared_app_state_json::text)+octet_length(s.assets_json::text) AS bytes
      FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_excalidraw_states s ON s.document_id=d.id WHERE d.id=$1 FOR UPDATE OF d,l,s`, [requirement.sourceDocumentId]) as Row | undefined;
    const scope = stage.origin.sourceScope;
    if (!row || row.id !== requirement.sourceDocumentId || row.lineage_id !== requirement.sourceLineageId || row.lineage_id_actual !== requirement.sourceLineageId
      || row.workspace_id !== scope.workspaceId || row.lineage_workspace_id !== scope.workspaceId || row.scene_workspace_id !== scope.workspaceId
      || row.workspace_type !== scope.workspaceType || row.lineage_workspace_type !== scope.workspaceType
      || row.organization_id !== scope.organizationId || row.lineage_organization_id !== scope.organizationId || row.scene_organization_id !== scope.organizationId
      || row.customer_id !== source.header.customer_id || row.lineage_customer_id !== source.header.lineage_customer_id
      || row.project_id !== source.header.project_id || row.lineage_project_id !== source.header.lineage_project_id
      || row.path !== requirement.sourcePath || row.lineage_path !== requirement.sourcePath || row.scene_path !== requirement.sourcePath
      || row.provider !== 'excalidraw' || row.status !== 'active' || row.lineage_status !== 'active' || row.scene_status !== 'active'
      || row.archived_at !== null || row.trash_entry_id !== source.header.lineage_trash_entry_id || row.document_id !== requirement.sourceDocumentId
      || Number(row.lifecycle_generation) !== requirement.sourceGeneration || Number(row.scene_sequence) !== requirement.sourceSceneSequence
      || row.canonical_hash !== requirement.sourceCanonicalHash || row.excalidraw_version !== source.scene.excalidrawVersion
      || Number(row.scene_schema_version) !== source.scene.sceneSchemaVersion || !copyInteger(Number(row.bytes), 1)) changed();
    remaining -= Number(row.bytes); if (remaining < 0 || Number(row.bytes) > 50 * 1024 * 1024) copyInvalid('EXCALIDRAW_COPY_TOO_LARGE');
    const body = await database.get(`SELECT elements_json,shared_app_state_json,assets_json FROM collaboration_excalidraw_states
      WHERE document_id=$1 AND octet_length(elements_json::text)+octet_length(shared_app_state_json::text)+octet_length(assets_json::text)<=$2`,
    [requirement.sourceDocumentId, Number(row.bytes)]) as Row | undefined;
    if (!body || !equal(body.elements_json, source.scene.elements) || !equal(body.shared_app_state_json, source.scene.appState)
      || !equal(body.assets_json, source.scene.assets) || canonicalSceneHash(source.scene) !== requirement.sourceCanonicalHash) changed();
  }
  // Keep the original source asset rows stable through this actual B1/B2 TX.
  // Captured bytes remain in C1; this verifies metadata without blob reads or
  // last-reference writes, including a cross-workspace registry loss/change.
  const expected = new Map(stage.sceneAssets.map(record => {
    if (record.workspaceId !== stage.origin.sourceScope.workspaceId) changed();
    return [record.asset.metadata.fileId, record.asset.metadata] as const;
  }));
  if (expected.size !== stage.sceneAssets.length || expected.size > 2000) changed();
  if (!expected.size) return;
  const workspaceId = stage.origin.sourceScope.workspaceId;
  const storageScope = createHash('sha256').update(workspaceId).digest('hex').slice(0, 32);
  // Untrusted row strings are bounded in SQL before transfer. The WHERE keys
  // themselves are the already bounded exact C1 workspace/file identifiers.
  const rows = await database.all(`SELECT workspace_id,file_id,
    CASE WHEN octet_length(content_sha256)=64 THEN content_sha256 END AS content_sha256,
    CASE WHEN octet_length(mime_type)<=64 THEN mime_type END AS mime_type,size_bytes,
    CASE WHEN octet_length(storage_key)<=97 THEN storage_key END AS storage_key,version,
    CASE WHEN octet_length(status)<=16 THEN status END AS status,created_at
    FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=ANY($2::text[])
    ORDER BY file_id LIMIT 2001 FOR SHARE`, [workspaceId, [...expected.keys()]]) as Row[];
  if (rows.length !== expected.size) changed();
  const seen = new Set<string>();
  for (const row of rows) {
    const metadata = typeof row.file_id === 'string' ? expected.get(row.file_id) : undefined;
    if (!metadata || seen.has(metadata.fileId) || row.workspace_id !== workspaceId || row.status !== 'available'
      || row.content_sha256 !== metadata.contentHash || row.mime_type !== metadata.mimeType
      || !copyInteger(Number(row.size_bytes), 1) || Number(row.size_bytes) !== metadata.sizeBytes
      || !copyInteger(Number(row.version), 1) || Number(row.version) !== metadata.version
      || !copyInteger(Number(row.created_at)) || Number(row.created_at) !== metadata.createdAt
      || row.storage_key !== `${storageScope}/${metadata.contentHash}`) changed();
    seen.add(metadata.fileId);
  }
}
async function vacant(database: SqlConnection, intent: ExcalidrawCopyIntent): Promise<void> {
  for (const document of intent.documents) {
    const rows = await database.all(`SELECT id FROM collaboration_documents WHERE (workspace_id=$1 AND path=$2 AND status='active') OR id=$3
      UNION ALL SELECT id FROM file_collaboration_lineages WHERE (workspace_id=$1 AND path=$2 AND status='active') OR id=$4
      UNION ALL SELECT document_id AS id FROM collaboration_excalidraw_states WHERE (workspace_id=$1 AND path=$2 AND status='active') OR document_id=$3
      UNION ALL SELECT document_id AS id FROM collaboration_yjs_states WHERE (workspace_id=$1 AND path=$2 AND status='active') OR document_id=$3 LIMIT 1`,
    [document.destinationWorkspaceId, document.destinationPath, document.documentId, document.lineageId]);
    if (rows.length) changed();
  }
}
async function assetRows(database: SqlConnection, original: ExcalidrawCopyAssetOriginal): Promise<Set<string>> {
  const rows = await database.all(`SELECT workspace_id,file_id,content_sha256,mime_type,size_bytes,storage_key,version,status,created_at
    FROM collaboration_excalidraw_assets WHERE workspace_id=$1 AND file_id=ANY($2::text[]) FOR UPDATE`,
  [original.destinationScope.workspaceId, original.metadata.map(row => row.fileId)]) as Row[];
  const result = new Set<string>();
  for (const row of rows) {
    const metadata = original.metadata.find(item => item.fileId === row.file_id), blob = original.blobs.find(item => item.contentHash === metadata?.contentHash);
    if (!metadata || !blob || result.has(metadata.fileId) || row.workspace_id !== original.destinationScope.workspaceId || row.status !== 'available'
      || row.content_sha256 !== metadata.contentHash || row.mime_type !== metadata.mimeType || Number(row.size_bytes) !== metadata.sizeBytes
      || Number(row.version) !== metadata.version || Number(row.created_at) !== metadata.createdAt || row.storage_key !== blob.storageKey) conflict();
    result.add(metadata.fileId);
  }
  return result;
}
export async function prepareExcalidrawCopyIntentsOnConnection(database: SqlConnection, input: Readonly<{
  stage: WorkspaceOperationManagedCopyStageV4; assetOriginal: ExcalidrawCopyAssetOriginal; nativeReceipt: NativeCopyReceipt;
}>): Promise<ExcalidrawCopyIntent> {
  const { stage } = input; checkedStage(stage); await assertNativeCopyManagedScenePreparationOnConnection(database, stage);
  const assetOriginal = captureExcalidrawCopyAssetOriginal(input.assetOriginal), existing = await readOriginalExcalidrawCopyOnConnection(database, { stage });
  if (existing) { if (!equal(existing.intent.assetOriginal, assetOriginal)) changed(); return existing.intent; }
  const transactionId = await xid(database), native = await nativeLedger(database, stage, input.nativeReceipt);
  if (native.xmin !== String(BigInt(transactionId) & BigInt('4294967295')) || native.publication_status !== 'native_committed') changed();
  const body = { version: 1 as const, operationId: stage.identity.operationId, stageDigest: stage.payloadSha256,
    requestHash: stage.identity.canonicalRequestHash, origin: stage.origin, nativeRequestFingerprint: input.nativeReceipt.requestFingerprint,
    nativeReceiptProof: nativeCopyPhaseReceiptProof(input.nativeReceipt), b1TransactionId: transactionId, createdAt: Number(native.created_at), assetOriginal,
    documents: stage.plan.sceneCopyRequirements.map(requirement => ({ ...requirement, documentId: randomUUID(), lineageId: randomUUID() })) };
  const intent = captureExcalidrawCopyIntent({ ...body, intentDigest: copyDigest(body) }); bind(intent, stage);
  await lockScenes(database, stage, intent); await currentSources(database, stage); await vacant(database, intent); await assetRows(database, assetOriginal);
  await assertNativeCopyManagedScenePreparationOnConnection(database, stage);
  const row = await database.get(`INSERT INTO ${TABLE} (workspace_id,operation_id,version,stage_digest,request_hash,native_request_fingerprint,
    intent_digest,intent_json,b1_transaction_id,created_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING xmin::text AS xmin`,
  [stage.identity.destinationWorkspaceId, intent.operationId, intent.stageDigest, intent.requestHash, intent.nativeRequestFingerprint,
    intent.intentDigest, JSON.stringify(intent), intent.b1TransactionId, intent.createdAt]) as Row | undefined;
  if (!row || row.xmin !== native.xmin || await xid(database) !== transactionId) changed();
  await assertNativeCopyManagedScenePreparationOnConnection(database, stage); return intent;
}
function paths(stage: WorkspaceOperationManagedCopyStageV4, supplied: readonly NativeCopyPhasePathReceipt[]): readonly string[] {
  const captured = copyCapture(supplied) as readonly NativeCopyPhasePathReceipt[];
  if (!Array.isArray(captured) || captured.length !== stage.physical.length) changed();
  const seen = new Set<number>();
  const proofs = captured.map((row: NativeCopyPhasePathReceipt) => {
    const expected = stage.physical.find(item => item.selectionIndex === row.selectionIndex);
    if (!expected || seen.has(row.selectionIndex) || !equal(expected.original, row.receipt.original)
      || row.receipt.observation.kind !== 'published' && row.receipt.observation.kind !== 'projection_absent') changed();
    seen.add(row.selectionIndex);
    if (expected.original.version === 3 && expected.original.derivedFiles.length) {
      if (row.receipt.observation.kind !== 'published') changed();
      const payload = row.receipt.observation.copy;
      for (const derived of expected.original.derivedFiles) {
        const relative = derived.path === expected.original.sourcePath ? '' : derived.path.slice(expected.original.sourcePath.length + 1);
        const leaf = payload.kind === 'directory' ? payload.entries.find(item => item.relativePath === relative) : relative === '' ? payload : undefined;
        if (!leaf || leaf.kind !== 'regular_file' || leaf.sha256 !== derived.sha256 || Number(leaf.identity.size) !== derived.sizeBytes) changed();
      }
    }
    preparedWorkspacePathCopyProof(row.receipt.original); return copyDigest(row);
  });
  return copyFreeze(proofs);
}
/** Borrowed B2 only: no helper below opens/commits a second connection. */
export async function commitExcalidrawCopiesOnConnection(database: SqlConnection, input: Readonly<{
  stage: WorkspaceOperationManagedCopyStageV4; intent: ExcalidrawCopyIntent; assetReceipt: ExcalidrawCopyAssetReceipt;
  pathReceipts: readonly NativeCopyPhasePathReceipt[];
}>): Promise<ExcalidrawCopyBirthReceipt> {
  const { stage } = input; checkedStage(stage); await assertNativeCopyManagedSceneCompletionOnConnection(database, stage);
  const intent = captureExcalidrawCopyIntent(input.intent), assetReceipt = captureExcalidrawCopyAssetReceipt(input.assetReceipt, intent.assetOriginal);
  bind(intent, stage); const current = await readOriginalExcalidrawCopyOnConnection(database, { stage });
  if (!current || !equal(current.intent, intent)) changed();
  if (current.receipt) return current.receipt;
  const transactionId = await xid(database), pathReceiptProofs = paths(stage, input.pathReceipts);
  await lockScenes(database, stage, intent); await currentSources(database, stage); await vacant(database, intent);
  const existingAssets = await assetRows(database, intent.assetOriginal);
  await assertPublishedExcalidrawCopyAssets(intent.assetOriginal, assetReceipt);
  await assertNativeCopyManagedSceneCompletionOnConnection(database, stage);
  const now = Date.now(), destination = stage.origin.destinationScope;
  for (const metadata of intent.assetOriginal.metadata) if (!existingAssets.has(metadata.fileId)) {
    const blob = intent.assetOriginal.blobs.find(item => item.contentHash === metadata.contentHash)!;
    await database.run(`INSERT INTO collaboration_excalidraw_assets (workspace_id,file_id,content_sha256,mime_type,size_bytes,storage_key,version,status,created_at,last_referenced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8,$9)`, [destination.workspaceId, metadata.fileId, metadata.contentHash,
      metadata.mimeType, metadata.sizeBytes, blob.storageKey, metadata.version, metadata.createdAt, now]);
  }
  const documents: ExcalidrawCopyBirthReceipt['documents'][number][] = [];
  for (const doc of intent.documents) {
    const source = stage.sceneRecords.find(row => row.header.id === doc.sourceDocumentId)!.scene;
    await database.run(`INSERT INTO file_collaboration_lineages (id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,status,created_at,archived_at,trash_entry_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,NULL,NULL)`, [doc.lineageId, destination.organizationId, destination.customerId,
      destination.projectId, destination.workspaceId, destination.workspaceType, doc.destinationPath, now]);
    await database.run(`INSERT INTO collaboration_documents (id,lineage_id,organization_id,customer_id,project_id,workspace_id,workspace_type,path,provider,state_version,snapshot_revision_id,status,created_at,updated_at,yjs_state_lifecycle)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'excalidraw',0,NULL,'active',$9,$9,'never_initialized')`, [doc.documentId, doc.lineageId,
      destination.organizationId, destination.customerId, destination.projectId, destination.workspaceId, destination.workspaceType, doc.destinationPath, now]);
    await database.run(`INSERT INTO collaboration_excalidraw_states (document_id,workspace_id,organization_id,path,lifecycle_generation,excalidraw_version,scene_schema_version,
      elements_json,shared_app_state_json,assets_json,scene_sequence,checkpoint_sequence,checkpoint_revision_id,checkpoint_content_hash,canonical_hash,persisted_at,checkpointed_at,degraded_reason,status)
      VALUES ($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,0,0,NULL,NULL,$10,$11,NULL,NULL,'active')`,
    [doc.documentId, destination.workspaceId, destination.organizationId, doc.destinationPath, source.excalidrawVersion, source.sceneSchemaVersion,
      JSON.stringify(source.elements), JSON.stringify(source.appState), JSON.stringify(source.assets), doc.sourceCanonicalHash, now]);
    documents.push({ documentId: doc.documentId, lineageId: doc.lineageId, workspaceId: destination.workspaceId, path: doc.destinationPath,
      lifecycleGeneration: 1, sceneSequence: 0, canonicalHash: doc.sourceCanonicalHash, persistedAt: now });
  }
  const body = { version: 1 as const, operationId: intent.operationId, stageDigest: intent.stageDigest, intent, documents,
    assetReceipt, pathReceiptProofs, b2TransactionId: transactionId };
  const receipt = captureExcalidrawCopyBirthReceipt({ ...body, receiptProof: copyDigest(body) });
  await assertPublishedExcalidrawCopyAssets(intent.assetOriginal, assetReceipt);
  await assertNativeCopyManagedSceneCompletionOnConnection(database, stage);
  const written = await database.get(`UPDATE ${TABLE} SET birth_json=$3::jsonb,birth_digest=$4,b2_transaction_id=$5,completed_at=$6
    WHERE workspace_id=$1 AND operation_id=$2 AND birth_json IS NULL AND intent_digest=$7 RETURNING xmin::text AS xmin`,
  [destination.workspaceId, intent.operationId, JSON.stringify(receipt), receipt.receiptProof, transactionId, now, intent.intentDigest]) as Row | undefined;
  if (!written || written.xmin !== String(BigInt(transactionId) & BigInt('4294967295')) || await xid(database) !== transactionId) changed();
  await assertNativeCopyManagedSceneCompletionOnConnection(database, stage); return receipt;
}
export function excalidrawCopyReceiptProof(receipt: ExcalidrawCopyBirthReceipt): string {
  return captureExcalidrawCopyBirthReceipt(receipt).receiptProof;
}
