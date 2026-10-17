import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { authoritativeCollaborationSnapshot } from '../collaboration/checkpoint';
import { serializeCanonicalText } from '../collaboration/persistence';
import { prepareNativeFileArchiveTransition, type NativeFileArchiveExpected, type NativeFileArchiveTransition } from '../collaboration/native-file-archive-transition';
import { readWorkspaceDocumentCatalogue } from '../collaboration/workspace-document-catalogue';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { withPreparedWorkspaceSingleFileTrash, withRecoveredWorkspaceSingleFileTrash,
  readPreparedWorkspaceSingleFileTrash, movePreparedWorkspaceSingleFileTrash,
  assertPreparedWorkspaceSingleFileTrashCurrent, assertPreparedWorkspaceSingleFileTrashSourceVacant,
  type PreparedWorkspaceSingleFileTrash, type PreparedSingleFileTrashOriginalFacts } from '../filesystem/prepared-single-file-trash';
import { withPreparedWorkspaceSingleFileRestore, withRecoveredWorkspaceSingleFileRestore,
  readPreparedWorkspaceSingleFileRestore, readPreparedWorkspaceSingleFileRestoreDisposition, restorePreparedWorkspaceSingleFileTrash,
  assertPreparedWorkspaceSingleFileRestoreCurrent, type PreparedWorkspaceSingleFileRestore } from '../filesystem/prepared-single-file-trash';
import { computeWorkspaceOperationBatchPlanId } from './workspace-operation-batch-plan';
import { decodeWorkspaceOperationNativeDeleteBatchPlan, assertWorkspaceOperationNativeDeleteBatchPlanCurrent,
  captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness } from './workspace-operation-native-delete-plan';
import type { WorkspaceOperationNativeSourceEvidenceV2 } from './workspace-operation-native-source-evidence';
import { decodeWorkspaceOperationNativeOriginalSourceWitness } from './workspace-operation-native-original-source';
import { prepareOriginalDeleteNativeLinks, assertOriginalDeleteNativeLinkPlan,
  assertOriginalDeleteNativeFinalGraph, assertOriginalDeleteNativeLinkCompletionBudget } from './workspace-operation-original-delete-links';
import { assertWorkspaceOperationNativeDeleteUndoGraphCurrent } from './workspace-operation-native-delete-undo-graph';
import { readWorkspaceLinkSourceAuthorityOnConnection } from '../markdown/workspace-source-authority-stage';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { withWorkspaceOperationJobLifecycleOwner, withWorkspaceOperationJobLifecycleTransaction,
  type WorkspaceOperationJobLifecycleAccess } from './workspace-operation-job-lifecycle-owner';
import { readOriginalNativeDeleteTargetOnConnection, archiveOriginalNativeDeleteTargetOnConnection,
  readOriginalNativeRestoreTargetOnConnection, restoreOriginalNativeDeleteTargetOnConnection } from './workspace-operation-original-delete-native';
import { captureOriginalDeletePublicShareOnConnection, assertOriginalDeletePublicShareOnConnection, applyOriginalDeletePublicShareOnConnection } from './workspace-operation-original-delete-public';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, readWorkspaceOperationOriginalDeleteReceiptOnConnection,
  readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection, insertWorkspaceOperationOriginalDeleteIntentOnConnection,
  insertWorkspaceOperationOriginalDeleteReceiptOnConnection, insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection,
  readWorkspaceOperationOriginalRestoreIntentOnConnection, readWorkspaceOperationOriginalRestoreReceiptOnConnection,
  insertWorkspaceOperationOriginalRestoreIntentOnConnection, insertWorkspaceOperationOriginalRestoreReceiptOnConnection } from './workspace-operation-original-delete-repository';
import { parseIntent, completed, parseRestoreIntent, restored, WorkspaceOperationOriginalDeleteError, assertOriginalDeleteIntentPlan,
  type OriginalIntent, type Completion, type RestoreIntent, type RestoreCompletion,
  type WorkspaceOperationOriginalDeleteResult, type WorkspaceOperationOriginalRestoreResult,
  type WorkspaceOperationOriginalDeleteEvidenceContext } from './workspace-operation-original-delete-evidence';
export { WorkspaceOperationOriginalDeleteError } from './workspace-operation-original-delete-evidence';
export type { WorkspaceOperationOriginalDeleteResult, WorkspaceOperationOriginalRestoreResult } from './workspace-operation-original-delete-evidence';

type Row = Record<string, unknown>;
function fail(code: WorkspaceOperationOriginalDeleteError['code']): never { throw new WorkspaceOperationOriginalDeleteError(code); }
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const json = (value: unknown): string => JSON.stringify(value);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function selection(claim: WorkspaceOperationBatchClaim, actionMode: 'apply' | 'undo' = 'apply'): WorkspaceOperationBatchClaimBinding {
  const binding = readWorkspaceOperationBatchClaimBinding(claim), { plan, authorization } = binding;
  if (plan.version === 3) fail('ORIGINAL_DELETE_UNSUPPORTED');
  const step = plan.pathSteps[0], action = plan.actions[0], deleted = plan.deletedPaths[0];
  if (binding.actionMode !== actionMode || authorization.mode !== 'direct' || !authorization.jobScope
    || authorization.jobScope.legacy || ![1, 2].includes(plan.version) || plan.readiness !== 'ready' || plan.issues.length
    || plan.workspaceId !== binding.workspaceId || plan.planId !== binding.planId
    || computeWorkspaceOperationBatchPlanId(plan) !== binding.planId || plan.pathSteps.length !== 1
    || step.kind !== 'delete' || step.destinationPath !== undefined || plan.actions.length !== 1
    || action.kind !== 'delete' || action.reviewId !== step.reviewId || action.selections.length !== 1
    || action.selections[0].sourcePath !== step.sourcePath || action.selections[0].destinationPath !== undefined
    || plan.deletedPaths.length !== 1 || deleted.kind !== 'file' || deleted.path !== step.sourcePath
    || plan.pathMappings.length || plan.linkEdits.length || plan.originalDocuments.length || plan.previewContents.length
    || !plan.coverage.complete || !plan.linkAssessment.complete || plan.linkAssessment.blockers.length) fail('ORIGINAL_DELETE_UNSUPPORTED');
  if (plan.version === 2) {
    const native = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
    if (!equal(native.sourceEvidence.workspaceScope, authorization.jobScope)) fail('ORIGINAL_DELETE_UNSUPPORTED');
    if (actionMode === 'undo' && native.nativeGraphPlan.steps.some(step => step.linkIntents.length)) fail('ORIGINAL_DELETE_UNSUPPORTED');
  }
  return binding;
}
function actor(binding: WorkspaceOperationBatchClaimBinding): OriginalIntent['actor'] {
  const auth = binding.authorization; if (auth.mode !== 'direct') fail('ORIGINAL_DELETE_INVALID');
  return Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null });
}

async function assertNoCompetingWriter(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  // This first closed runner does not adopt/release another writer's lock or a
  // Guest lifecycle. Those cases remain explicit unsupported/busy outcomes.
  const locks = await access.database.all(`SELECT id FROM ${prefix}.file_locks WHERE workspace_id=$1 AND path=$2
    AND status='active' AND expires_at>$3 FOR SHARE NOWAIT`, [access.workspace.workspaceId, source, Date.now()]);
  const guests = await access.database.all(`SELECT id FROM ${prefix}.file_guest_invitations WHERE workspace_id=$1 AND path=$2
    AND status='active' FOR SHARE NOWAIT`, [access.workspace.workspaceId, source]);
  const agents = await access.database.all(`SELECT o.operation_id FROM ${prefix}.collaboration_agent_operations o
    JOIN ${prefix}.collaboration_documents d ON d.id=o.document_id WHERE d.workspace_id=$1 AND d.path=$2
      AND o.status IN ('preparing','ready','applying','applied_to_ydoc','cancel_requested') FOR SHARE OF o NOWAIT`,
  [access.workspace.workspaceId, source]);
  if (locks.length || guests.length || agents.length) fail('ORIGINAL_DELETE_BUSY');
}
async function removeOriginalDeleteAnnotations(access: WorkspaceOperationJobLifecycleAccess, prefix: string,
  source: string, prepared: PreparedWorkspaceSingleFileTrash): Promise<void> {
  await assertNoCompetingWriter(access, prefix, source);
  await assertPreparedWorkspaceSingleFileTrashSourceVacant(prepared);
  await access.database.run(`DELETE FROM ${prefix}.workspace_file_metadata WHERE workspace_id=$1 AND path=$2`,
    [access.workspace.workspaceId, source]);
  await access.database.run(`DELETE FROM ${prefix}.workspace_file_user_states WHERE workspace_id=$1 AND path=$2`,
    [access.workspace.workspaceId, source]);
  await assertNoCompetingWriter(access, prefix, source);
  await assertPreparedWorkspaceSingleFileTrashSourceVacant(prepared);
}
async function assertStillPhysical(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  // Reject a new native owner of these same projection bytes; never adopt that
  // D2 as our original target. Completed historical receipts skip this path.
  for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) {
    if (await access.database.get(`SELECT 1 AS present FROM ${prefix}.${table} WHERE workspace_id=$1 AND path=$2
      AND status='active' LIMIT 1 FOR SHARE NOWAIT`, [access.workspace.workspaceId, source])) fail('ORIGINAL_DELETE_CHANGED');
  }
}
function assertPlanSource(binding: WorkspaceOperationBatchClaimBinding, physical: PreparedSingleFileTrashOriginalFacts,
  native: NativeFileArchiveExpected | null, nativeContentHash: string | null,
  currentWitness?: WorkspaceOperationNativeSourceEvidenceV2): void {
  if (binding.plan.version === 2) {
    const plan = decodeWorkspaceOperationNativeDeleteBatchPlan(binding.plan);
    const evidence = plan.planIdentityVersion === 2
      ? decodeWorkspaceOperationNativeOriginalSourceWitness(plan.sourceEvidence, currentWitness) : plan.sourceEvidence;
    const expected = plan.planIdentityVersion === 2
      ? evidence.nativeBindings.find(binding => binding.expected.documentId === plan.nativeTarget.documentId)?.expected : plan.nativeTarget;
    const entry = evidence.stage.namespace.find(candidate => candidate.path === physical.canonicalPath);
    const actual = physical.source.kind === 'regular_file' ? physical.source.identity : null;
    const physicalIdentity = actual ? `${actual.device}:${actual.inode}:${actual.size}:${actual.mtimeMs}:${actual.ctimeMs}` : null;
    if (!native || !equal(native, expected) || !entry || entry.documentId !== native.documentId
      || entry.filesystemIdentity !== physicalIdentity) fail('ORIGINAL_DELETE_CHANGED');
    return;
  }
  const source = physical.source, expectedIdentity = source.kind === 'regular_file'
    ? `${source.identity.device}:${source.identity.inode}:${source.identity.size}:${source.identity.mtimeMs}:${source.identity.ctimeMs}`
    : native && `native:${native.stateProof}`;
  if (!expectedIdentity || binding.plan.deletedPaths[0].identity !== expectedIdentity) fail('ORIGINAL_DELETE_CHANGED');
  for (const expected of binding.plan.expectedPathState) {
    if (expected.workspaceId !== binding.workspaceId || expected.path !== physical.canonicalPath
      || expected.identity !== expectedIdentity || expected.contentHash !== null
      && expected.contentHash !== nativeContentHash && (source.kind !== 'regular_file' || expected.contentHash !== source.sha256)) fail('ORIGINAL_DELETE_CHANGED');
  }
  if (source.kind === 'projection_absent' && native === null) fail('ORIGINAL_DELETE_UNPROVEN');
}

async function prepareIntent(access: WorkspaceOperationJobLifecycleAccess, binding: WorkspaceOperationBatchClaimBinding,
  physical: PreparedSingleFileTrashOriginalFacts): Promise<OriginalIntent> {
  const schema = binding.source.schemaName, prefix = quote(schema), source = physical.canonicalPath;
  await assertNoCompetingWriter(access, prefix, source);
  const observation = binding.plan.version === 2 ? await access.readOriginalNativeDeleteSources() : null;
  const currentWitness = binding.plan.version === 2 && binding.plan.planIdentityVersion === 2 && observation
    ? captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(binding.plan, observation,
      binding.authorization.mode === 'direct' ? binding.authorization.jobScope! : fail('ORIGINAL_DELETE_INVALID')) : null;
  if (binding.plan.version === 2 && observation && !currentWitness) assertWorkspaceOperationNativeDeleteBatchPlanCurrent(binding.plan, observation,
    binding.authorization.mode === 'direct' ? binding.authorization.jobScope! : fail('ORIGINAL_DELETE_INVALID'));
  const catalogue = await readWorkspaceDocumentCatalogue(access.database, access.workspace, { paths: [source], maxEntries: 2 });
  if (catalogue.some(entry => entry.path !== source) || catalogue.length > 1) fail('ORIGINAL_DELETE_UNSUPPORTED');
  let native: NativeFileArchiveExpected | null = null, nativeContentHash: string | null = null;
  let nativeTransition: NativeFileArchiveTransition | null = null;
  if (catalogue.length) {
    const entry = catalogue[0];
    if (entry.authority !== 'initialized' || !entry.lineage_id) fail('ORIGINAL_DELETE_UNSUPPORTED');
    const original = await readOriginalNativeDeleteTargetOnConnection(access.database,
      { schema, workspace: access.workspace, documentId: entry.id, lineageId: entry.lineage_id, path: source });
    native = original.expected;
    // Native archive authority does not require a lossless Markdown export.
    // Export only when this particular stored plan actually demands that hash.
    const requiresNativeContent = binding.plan.version === 1 && binding.plan.expectedPathState.some(expected => expected.contentHash !== null
      && (physical.source.kind !== 'regular_file' || expected.contentHash !== physical.source.sha256));
    if (requiresNativeContent) nativeContentHash = digest(serializeCanonicalText(
      authoritativeCollaborationSnapshot(original.state).canonicalContent, original.state));
    // Reject archive limits/quarantine before making the physical transition.
    nativeTransition = prepareNativeFileArchiveTransition(original.state, native, { trashEntryId: physical.trashEntryId, archivedAt: physical.deletedAtMs });
  } else if (await access.database.get(`SELECT id FROM ${prefix}.file_collaboration_lineages WHERE workspace_id=$1
    AND path=$2 AND status='active' LIMIT 1 FOR SHARE NOWAIT`, [binding.workspaceId, source])) fail('ORIGINAL_DELETE_UNSUPPORTED');
  assertPlanSource(binding, physical, native, nativeContentHash, currentWitness ?? undefined);
  const publicShare = await captureOriginalDeletePublicShareOnConnection(access.database,
    { schema, workspace: access.workspace, path: source, ...(native ? { nativeExpected: native } : {}) });
  const auth = binding.authorization; if (auth.mode !== 'direct' || !auth.jobScope) fail('ORIGINAL_DELETE_INVALID');
  const nativeLinks = binding.plan.version === 2 && observation ? prepareOriginalDeleteNativeLinks(binding.plan, observation,
    { batchId: binding.batchId, workspaceId: binding.workspaceId, sourcePath: source, requestHash: auth.requestHash, actor: actor(binding) }) : [];
  if (nativeLinks.length && !access.workspace.permissions.canWrite) {
    throw Object.assign(new Error('Current workspace write permission is required to update incoming links.'), { status: 403 });
  }
  for (const item of nativeLinks) await assertNoCompetingWriter(access, prefix, item.prepared.source.path);
  const fields = { batchId: binding.batchId, planId: binding.planId, requestHash: auth.requestHash,
    actor: actor(binding), jobScope: auth.jobScope, physical, native, publicShare };
  const value: OriginalIntent = currentWitness ? { ...fields, version: 3, currentWitness, nativeLinks }
    : { ...fields, version: nativeLinks.length ? 2 : 1, ...(nativeLinks.length ? { nativeLinks } : {}) };
  if (Buffer.byteLength(json(value)) > 1048576) fail('ORIGINAL_DELETE_UNSUPPORTED');
  if (nativeLinks.length && observation) {
    // The original facts and predicted native transition are exact. Every
    // finite JSON numeric identity value is shorter than this 64-byte reserve;
    // the fixed public result is bounded below 32 KiB by its existing codec.
    const observationBudget = physical.source.kind === 'regular_file' ? { kind: 'moved', method: 'rename',
      identity: Object.fromEntries(Object.keys(physical.source.identity).map(key => [key, 'N'.repeat(64)])), sha256: '0'.repeat(64) }
      : { kind: 'projection_absent' };
    const envelope = { version: 2, batchId: binding.batchId, intentDigest: '0'.repeat(64), trashEntryId: physical.trashEntryId,
      physical: { version: 1, original: physical, observation: observationBudget }, native: nativeTransition,
      publicShare: 'P'.repeat(32768), trashReceiptDigest: '0'.repeat(64), nativeLinks: [] };
    assertOriginalDeleteNativeLinkCompletionBudget(nativeLinks, observation, Buffer.byteLength(json(envelope)), currentWitness ? 3 : undefined);
  }
  return freeze(value);
}

function trashMetadata(intent: OriginalIntent, intentDigest: string): string {
  return json({ version: 1, retentionDays: intent.physical.retentionDays, workspaceType: intent.jobScope.workspaceType,
    requestedPath: intent.physical.canonicalPath, originalDeleteIntent: intentDigest,
    payloadKind: intent.physical.source.kind === 'regular_file' ? 'file' : 'native_archive',
    nativeDocumentId: intent.native?.documentId ?? null, nativeLineageId: intent.native?.lineageId ?? null });
}
async function insertTrash(access: WorkspaceOperationJobLifecycleAccess, prefix: string, intent: OriginalIntent, intentDigest: string): Promise<void> {
  const { physical, jobScope } = intent, size = physical.source.kind === 'regular_file' ? physical.source.identity.size : 0;
  const inserted = await access.database.get(`INSERT INTO ${prefix}.workspace_trash_entries
    (id,organization_id,customer_id,project_id,workspace_id,workspace_type,owner_user_id,original_path,trash_relative_path,
    entry_name,item_type,size_bytes,file_count,directory_count,status,deleted_by_user_id,deleted_at,expires_at,metadata_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'file',$11,1,0,'trashed',$12,$13,$14,$15) ON CONFLICT(id) DO NOTHING RETURNING id`,
  [physical.trashEntryId, jobScope.organizationId, jobScope.customerId, jobScope.projectId, jobScope.workspaceId,
    jobScope.workspaceType, jobScope.ownerUserId, physical.canonicalPath, physical.trashRelativePath,
    path.posix.basename(physical.canonicalPath), size, intent.actor.userId, physical.deletedAtMs, physical.expiresAtMs, trashMetadata(intent, intentDigest)]);
  if (!inserted) fail('ORIGINAL_DELETE_UNPROVEN');
  const row = await access.database.get(`SELECT * FROM ${prefix}.workspace_trash_entries WHERE id=$1 FOR SHARE NOWAIT`, [physical.trashEntryId]) as Row | undefined;
  verifyTrashRow(intent, intentDigest, row);
}
export function verifyTrashRow(intent: OriginalIntent, intentDigest: string, row: Row | undefined,
  restore?: Readonly<{ userId: string; restoredAt: number }>): asserts row is Row {
  const { physical, jobScope } = intent, size = physical.source.kind === 'regular_file' ? physical.source.identity.size : 0;
  if (!row || row.id !== physical.trashEntryId || row.organization_id !== jobScope.organizationId || row.customer_id !== jobScope.customerId
    || row.project_id !== jobScope.projectId || row.workspace_id !== jobScope.workspaceId || row.workspace_type !== jobScope.workspaceType
    || row.owner_user_id !== jobScope.ownerUserId || row.original_path !== physical.canonicalPath || row.trash_relative_path !== physical.trashRelativePath
    || row.entry_name !== path.posix.basename(physical.canonicalPath) || row.item_type !== 'file' || Number(row.size_bytes) !== size
    || Number(row.file_count) !== 1 || Number(row.directory_count) !== 0 || row.status !== (restore ? 'restored' : 'trashed')
    || row.deleted_by_user_id !== intent.actor.userId || Number(row.deleted_at) !== physical.deletedAtMs || Number(row.expires_at) !== physical.expiresAtMs
    || row.metadata_json !== trashMetadata(intent, intentDigest)
    || row.restored_by_user_id !== (restore?.userId ?? null) || (restore ? Number(row.restored_at) !== restore.restoredAt : row.restored_at !== null)
    || row.purged_by_user_id !== null || row.purged_at !== null) fail('ORIGINAL_DELETE_POSTCONDITION');
}

/** Original single-file Delete path stage. The native V2 arm rechecks its full
 * source/graph basis on the genuine B; no Markdown export or span plan is used. */
export async function executeWorkspaceOperationOriginalDelete(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<WorkspaceOperationOriginalDeleteResult> {
  const binding = selection(claim), schema = binding.source.schemaName, prefix = quote(schema);
  const evidenceContext: WorkspaceOperationOriginalDeleteEvidenceContext = Object.freeze({ batchId: binding.batchId,
    planId: binding.planId, workspaceId: binding.workspaceId, authorization: binding.authorization,
    sourcePath: binding.plan.pathSteps[0].sourcePath });
  return withWorkspaceOperationJobLifecycleOwner(claim, async owner => {
    const observe = () => withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
      const durable = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      const receipt = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      const trash = await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      if (!durable && (receipt || trash) || durable && !receipt && trash) fail('ORIGINAL_DELETE_UNPROVEN');
      const intent = durable ? parseIntent(durable, evidenceContext, access.workspace, resolveWorkspaceDataRoot()) : null;
      if (intent && binding.plan.version === 2) {
        assertOriginalDeleteIntentPlan(intent, binding.plan);
        assertPlanSource(binding, intent.physical, intent.native, null, intent.currentWitness);
        assertOriginalDeleteNativeLinkPlan(binding.plan, intent.nativeLinks ?? []);
      }
      return { workspace: access.workspace, durable, intent, result: receipt && durable && intent ? completed(receipt, trash, durable, intent) : null };
    });
    const observed = await observe();
    if (observed.result) return observed.result; // Historical completion, never inspect/adopt current D2/S2.
    const apply = async (prepared: PreparedWorkspaceSingleFileTrash) => {
      let durable = observed.durable, intent = observed.intent;
      if (!durable || !intent) {
        const captured = await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
          const value = await prepareIntent(access, binding, readPreparedWorkspaceSingleFileTrash(prepared));
          const inserted = await insertWorkspaceOperationOriginalDeleteIntentOnConnection(access.database,
            { schema, batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
              requestHash: value.requestHash, intentText: json(value) });
          if (inserted.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
          return { durable: inserted.row, intent: value };
        });
        durable = captured.durable; intent = captured.intent;
      }
      const originalIntent = intent, originalDurable = durable;
      // A resumed intent is historical data. Recheck its original D1/S1 before
      // attempting a rename, then check them again in the atomic SQL apply.
      await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const current = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
        if (!current || !equal(current, originalDurable)) fail('ORIGINAL_DELETE_CHANGED');
        parseIntent(current, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
        if (originalIntent.nativeLinks?.length && !access.workspace.permissions.canWrite) {
          throw Object.assign(new Error('Current workspace write permission is required to update incoming links.'), { status: 403 });
        }
        await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
        for (const item of originalIntent.nativeLinks ?? []) await assertNoCompetingWriter(access, prefix, item.prepared.source.path);
        if (binding.plan.version === 2) assertWorkspaceOperationNativeDeleteBatchPlanCurrent(binding.plan,
          await access.readOriginalNativeDeleteSources(), originalIntent.jobScope);
        if (originalIntent.native) {
          const native = await readOriginalNativeDeleteTargetOnConnection(access.database, { schema, workspace: access.workspace,
            documentId: originalIntent.native.documentId, lineageId: originalIntent.native.lineageId, path: originalIntent.native.path });
          if (!equal(native.expected, originalIntent.native)) fail('ORIGINAL_DELETE_CHANGED');
        } else await assertStillPhysical(access, prefix, originalIntent.physical.canonicalPath);
        await assertOriginalDeletePublicShareOnConnection(access.database,
          { schema, workspace: access.workspace, original: originalIntent.publicShare, nowMs: originalIntent.physical.deletedAtMs });
      });
      const physical = await movePreparedWorkspaceSingleFileTrash(prepared);
      return withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const current = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
        if (!current || !equal(current, originalDurable) || !equal(physical.original, originalIntent.physical)) fail('ORIGINAL_DELETE_CHANGED');
        parseIntent(current, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
        await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
        for (const item of originalIntent.nativeLinks ?? []) await assertNoCompetingWriter(access, prefix, item.prepared.source.path);
        if (binding.plan.version === 2) assertWorkspaceOperationNativeDeleteBatchPlanCurrent(binding.plan,
          await access.readOriginalNativeDeleteSources(), originalIntent.jobScope);
        if (!originalIntent.native) await assertStillPhysical(access, prefix, originalIntent.physical.canonicalPath);
        const prior = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
        if (prior) fail('ORIGINAL_DELETE_UNPROVEN');
        const nativeLinks = (originalIntent.version === 2 || originalIntent.version === 3) && originalIntent.nativeLinks?.length
          ? await access.applyOriginalNativeDeleteLinks(current.intentDigest) : [];
        const native = originalIntent.native ? await archiveOriginalNativeDeleteTargetOnConnection(access.database,
          { schema, workspace: access.workspace, expected: originalIntent.native, trashEntryId: originalIntent.physical.trashEntryId,
            archivedAt: originalIntent.physical.deletedAtMs }) : null;
        const publicShare = await applyOriginalDeletePublicShareOnConnection(access.database,
          { schema, workspace: access.workspace, original: originalIntent.publicShare, nowMs: originalIntent.physical.deletedAtMs });
        if (binding.plan.version === 2 && (originalIntent.version === 2 || originalIntent.version === 3)) assertOriginalDeleteNativeFinalGraph(binding.plan,
          await access.readOriginalNativeDeleteSources(), originalIntent.version === 3
            ? { sourceEvidence: originalIntent.currentWitness, nativeLinks } : undefined);
        await assertPreparedWorkspaceSingleFileTrashCurrent(prepared);
        await removeOriginalDeleteAnnotations(access, prefix, originalIntent.physical.canonicalPath, prepared);
        await insertTrash(access, prefix, originalIntent, current.intentDigest);
        const trash = await insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(physical) });
        if (trash.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
        const value: Completion = freeze({ version: originalIntent.version, batchId: binding.batchId, intentDigest: current.intentDigest,
          trashEntryId: originalIntent.physical.trashEntryId, physical, native, publicShare, trashReceiptDigest: trash.row.receiptDigest,
          ...(originalIntent.version === 2 || originalIntent.version === 3 ? { nativeLinks } : {}) });
        await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
        await assertPreparedWorkspaceSingleFileTrashSourceVacant(prepared);
        const receipt = await insertWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(value) });
        if (receipt.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
        await access.assertCurrent();
        await assertPreparedWorkspaceSingleFileTrashCurrent(prepared);
        await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
        await assertPreparedWorkspaceSingleFileTrashSourceVacant(prepared);
        return completed(receipt.row, trash.row, current, originalIntent);
      });
    };
    return observed.intent
      ? withRecoveredWorkspaceSingleFileTrash({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), original: observed.intent.physical }, apply)
      : withPreparedWorkspaceSingleFileTrash({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(),
        canonicalPath: binding.plan.pathSteps[0].sourcePath, trashEntryId: `trash-${randomUUID()}` }, apply);
  }, openConnection);
}

async function assertPhysicalRestoreVacancy(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) {
    if (await access.database.get(`SELECT 1 AS present FROM ${prefix}.${table} WHERE workspace_id=$1 AND status='active'
      AND (path=$2 OR left(path,length($2)+1)=$2||'/' OR left($2,length(path)+1)=path||'/') LIMIT 1 FOR SHARE NOWAIT`,
    [access.workspace.workspaceId, source])) fail('ORIGINAL_DELETE_CHANGED');
  }
}

/** Undo the actual completed original Delete, with a fresh genuine human Undo
 * claim. FS intent is committed before rename; native activation, original Trash
 * status and immutable completion share B2. No public share is reactivated. */
export async function undoWorkspaceOperationOriginalDelete(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<WorkspaceOperationOriginalRestoreResult> {
  const binding = selection(claim, 'undo'), schema = binding.source.schemaName, prefix = quote(schema);
  const evidenceContext: WorkspaceOperationOriginalDeleteEvidenceContext = Object.freeze({ batchId: binding.batchId,
    planId: binding.planId, workspaceId: binding.workspaceId, authorization: binding.authorization,
    sourcePath: binding.plan.pathSteps[0].sourcePath });
  return withWorkspaceOperationJobLifecycleOwner(claim, async owner => {
    const observed = await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
      const input = { schema, batchId: binding.batchId, forShare: true as const };
      const originalDurable = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, input);
      const originalReceipt = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, input);
      const originalTrash = await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database, input);
      if (!originalDurable || !originalReceipt || !originalTrash) fail('ORIGINAL_DELETE_UNPROVEN');
      const original = parseIntent(originalDurable, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
      if (binding.plan.version === 2) assertPlanSource(binding, original.physical, original.native, null);
      const originalResult = completed(originalReceipt, originalTrash, originalDurable, original);
      const durable = await readWorkspaceOperationOriginalRestoreIntentOnConnection(access.database, input);
      const receipt = await readWorkspaceOperationOriginalRestoreReceiptOnConnection(access.database, input);
      if (receipt && !durable) fail('ORIGINAL_DELETE_UNPROVEN');
      const intent = durable ? parseRestoreIntent(durable, evidenceContext, access.workspace, original, originalDurable, originalResult) : null;
      return { workspace: access.workspace, original, originalDurable, originalResult, durable, intent,
        result: receipt && durable && intent ? restored(receipt, durable, intent, original) : null };
    });
    // History is history: after confirmed original Undo, never inspect/adopt a
    // replacement document, public share or filesystem node at the old path.
    if (observed.result) return observed.result;
    const { original, originalDurable, originalResult } = observed;
    const checkTarget = async (access: WorkspaceOperationJobLifecycleAccess, intent: RestoreIntent, assessGraph = true): Promise<void> => {
      if (access.actorType !== 'user' || access.actorId !== intent.actorUserId || access.userId !== intent.actorUserId) fail('ORIGINAL_DELETE_UNPROVEN');
      await assertNoCompetingWriter(access, prefix, original.physical.canonicalPath);
      const trash = await access.database.get(`SELECT * FROM ${prefix}.workspace_trash_entries WHERE id=$1 FOR UPDATE NOWAIT`, [intent.trashEntryId]) as Row | undefined;
      verifyTrashRow(original, originalDurable.intentDigest, trash);
      if (original.native && originalResult.native) await readOriginalNativeRestoreTargetOnConnection(access.database,
        { schema, workspace: access.workspace, expected: original.native, archived: originalResult.native,
          trashEntryId: intent.trashEntryId, restoredAt: intent.restoredAtMs });
      else if (!original.native && !originalResult.native) await assertPhysicalRestoreVacancy(access, prefix, original.physical.canonicalPath);
      else fail('ORIGINAL_DELETE_UNPROVEN');
      if (binding.plan.version === 2 && assessGraph) assertWorkspaceOperationNativeDeleteUndoGraphCurrent(binding.plan,
        await readWorkspaceLinkSourceAuthorityOnConnection(access.database, access.workspace));
    };
    const apply = async (prepared: PreparedWorkspaceSingleFileRestore) => {
      let durable = observed.durable, intent = observed.intent;
      if (!durable || !intent) {
        const captured = await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
          const auth = binding.authorization; if (auth.mode !== 'direct') fail('ORIGINAL_DELETE_UNPROVEN');
          const value: RestoreIntent = freeze({ version: 1, batchId: binding.batchId, planId: binding.planId,
            requestHash: auth.requestHash, originalIntentDigest: originalDurable.intentDigest,
            originalReceiptDigest: originalResult.receiptDigest, trashEntryId: original.physical.trashEntryId,
            actorUserId: access.userId, jobScope: original.jobScope,
            restoredAtMs: Math.max(Date.now(), original.physical.deletedAtMs), physical: readPreparedWorkspaceSingleFileRestore(prepared) });
          if (!equal(value.physical.trashReceipt, originalResult.physical)) fail('ORIGINAL_DELETE_UNPROVEN');
          await checkTarget(access, value);
          const inserted = await insertWorkspaceOperationOriginalRestoreIntentOnConnection(access.database,
            { schema, batchId: binding.batchId, planId: binding.planId, workspaceId: binding.workspaceId,
              requestHash: value.requestHash, intentText: json(value) });
          if (inserted.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
          return { durable: inserted.row, intent: value };
        });
        durable = captured.durable; intent = captured.intent;
      }
      const restoreIntent = intent, restoreDurable = durable;
      await withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const current = await readWorkspaceOperationOriginalRestoreIntentOnConnection(access.database,
          { schema, batchId: binding.batchId, forShare: true });
        if (!current || !equal(current, restoreDurable)) fail('ORIGINAL_DELETE_CHANGED');
        parseRestoreIntent(current, evidenceContext, access.workspace, original, originalDurable, originalResult);
        // Recovery can already hold the exact restored original file while D1
        // is still archived. Assess its complete graph after the real B2 CAS;
        // parsing those known projection bytes as an unregistered .md source
        // would permanently block recovery. This phase performs no new rename.
        await checkTarget(access, restoreIntent, readPreparedWorkspaceSingleFileRestoreDisposition(prepared) !== 'already-restored');
      });
      const physical = await restorePreparedWorkspaceSingleFileTrash(prepared);
      return withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
        const current = await readWorkspaceOperationOriginalRestoreIntentOnConnection(access.database,
          { schema, batchId: binding.batchId, forShare: true });
        if (!current || !equal(current, restoreDurable) || !equal(physical.original, restoreIntent.physical)) fail('ORIGINAL_DELETE_CHANGED');
        parseRestoreIntent(current, evidenceContext, access.workspace, original, originalDurable, originalResult);
        await checkTarget(access, restoreIntent, false);
        if (await readWorkspaceOperationOriginalRestoreReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, forShare: true })) fail('ORIGINAL_DELETE_UNPROVEN');
        const native = original.native && originalResult.native ? await restoreOriginalNativeDeleteTargetOnConnection(access.database,
          { schema, workspace: access.workspace, expected: original.native, archived: originalResult.native,
            trashEntryId: restoreIntent.trashEntryId, restoredAt: restoreIntent.restoredAtMs }) : null;
        if (binding.plan.version === 2) assertWorkspaceOperationNativeDeleteUndoGraphCurrent(binding.plan,
          await readWorkspaceLinkSourceAuthorityOnConnection(access.database, access.workspace), 'after-restore');
        await assertPreparedWorkspaceSingleFileRestoreCurrent(prepared);
        const changed = await access.database.get(`UPDATE ${prefix}.workspace_trash_entries SET status='restored',restored_by_user_id=$1,
          restored_at=$2 WHERE id=$3 AND workspace_id=$4 AND status='trashed' RETURNING *`,
        [access.userId, restoreIntent.restoredAtMs, restoreIntent.trashEntryId, binding.workspaceId]) as Row | undefined;
        verifyTrashRow(original, originalDurable.intentDigest, changed, { userId: access.userId, restoredAt: restoreIntent.restoredAtMs });
        const reread = await access.database.get(`SELECT * FROM ${prefix}.workspace_trash_entries WHERE id=$1 FOR SHARE NOWAIT`,
          [restoreIntent.trashEntryId]) as Row | undefined;
        if (!equal(reread, changed)) fail('ORIGINAL_DELETE_POSTCONDITION');
        const value: RestoreCompletion = freeze({ version: 1, batchId: binding.batchId, intentDigest: current.intentDigest,
          originalReceiptDigest: originalResult.receiptDigest, trashEntryId: restoreIntent.trashEntryId,
          actorUserId: access.userId, restoredAtMs: restoreIntent.restoredAtMs, physical, native });
        const receipt = await insertWorkspaceOperationOriginalRestoreReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(value) });
        if (receipt.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
        await access.assertCurrent(); await assertPreparedWorkspaceSingleFileRestoreCurrent(prepared);
        return restored(receipt.row, current, restoreIntent, original);
      });
    };
    return observed.intent
      ? withRecoveredWorkspaceSingleFileRestore({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), original: observed.intent.physical }, apply)
      : withPreparedWorkspaceSingleFileRestore({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), receipt: originalResult.physical }, apply);
  }, openConnection);
}
