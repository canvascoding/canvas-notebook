import 'server-only';

import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import { assertPreparedWorkspaceSingleFileTrashCurrent, assertPreparedWorkspaceSingleFileTrashSourceVacant,
  type PreparedWorkspaceSingleFileTrash, type PreparedSingleFileTrashReceipt } from '../filesystem/prepared-single-file-trash';
import type { WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import type { WorkspaceOperationJobLifecycleAccess } from './workspace-operation-job-lifecycle-owner';
import { assertWorkspaceOperationNativeDeleteBatchPlanCurrent } from './workspace-operation-native-delete-plan';
import { assertOriginalDeleteNativeFinalGraph } from './workspace-operation-original-delete-links';
import { assertOriginalDeleteMixedFinalGraph } from './workspace-operation-original-delete-mixed-graph';
import { assertOriginalDeleteHtmlFinalGraph } from './workspace-operation-original-delete-html-graph';
import { assertOriginalDeleteNativeHtmlLinkReceiptsV4 } from './workspace-operation-original-delete-html-links';
import { assertOriginalDeleteNativeLinkReceipts } from './workspace-operation-original-delete-links';
import { archiveOriginalNativeDeleteTargetOnConnection } from './workspace-operation-original-delete-native';
import { applyOriginalDeletePublicShareOnConnection } from './workspace-operation-original-delete-public';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, readWorkspaceOperationOriginalDeleteReceiptOnConnection,
  insertWorkspaceOperationOriginalDeleteReceiptOnConnection, insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection,
  type WorkspaceOperationOriginalDeleteIntent } from './workspace-operation-original-delete-repository';
import { parseIntent, completed, WorkspaceOperationOriginalDeleteError,
  type OriginalIntent, type Completion, type WorkspaceOperationOriginalDeleteResult,
  type WorkspaceOperationOriginalDeleteEvidenceContext } from './workspace-operation-original-delete-evidence';

type Row = Record<string, unknown>;
function fail(code: WorkspaceOperationOriginalDeleteError['code']): never { throw new WorkspaceOperationOriginalDeleteError(code); }
const json = (value: unknown): string => JSON.stringify(value);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export async function assertNoCompetingWriter(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  // This first closed runner does not adopt/release another writer's lock or a
  // Guest lifecycle. Those cases remain explicit unsupported/busy outcomes.
  const [busy] = await access.database.all(`WITH
    locks AS MATERIALIZED (SELECT id FROM ${prefix}.file_locks WHERE workspace_id=$1 AND path=$2
      AND status='active' AND expires_at>$3 FOR SHARE NOWAIT),
    guests AS MATERIALIZED (SELECT id FROM ${prefix}.file_guest_invitations WHERE workspace_id=$1 AND path=$2
      AND status='active' FOR SHARE NOWAIT)
    SELECT (SELECT count(*) FROM locks)>0 AS locks, (SELECT count(*) FROM guests)>0 AS guests`,
  [access.workspace.workspaceId, source, Date.now()]) as Row[];
  const agents = await access.database.all(`SELECT o.operation_id FROM ${prefix}.collaboration_agent_operations o
    JOIN ${prefix}.collaboration_documents d ON d.id=o.document_id WHERE d.workspace_id=$1 AND d.path=$2
      AND o.status IN ('preparing','ready','applying','applied_to_ydoc','cancel_requested') FOR SHARE OF o NOWAIT`,
  [access.workspace.workspaceId, source]);
  if (busy.locks || busy.guests || agents.length) fail('ORIGINAL_DELETE_BUSY');
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
export async function assertStillPhysical(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  // Reject a new native owner of these same projection bytes; never adopt that
  // D2 as our original target. Completed historical receipts skip this path.
  for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'file_collaboration_lineages']) {
    if (await access.database.get(`SELECT 1 AS present FROM ${prefix}.${table} WHERE workspace_id=$1 AND path=$2
      AND status='active' LIMIT 1 FOR SHARE NOWAIT`, [access.workspace.workspaceId, source])) fail('ORIGINAL_DELETE_CHANGED');
  }
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

/** Fixed B2 domain algorithm only. The genuine lifecycle Owner supplies this
 * already-authorized restricted access, the original immutable facts and the
 * actual prepared capability/receipt. This function grants no owner, raw B,
 * transaction, Admission authority, replay or COMMIT acknowledgement.
 * For V4 only the fixed Owner calls it inside the actual-B DA04 mutate phase. */
export async function completeWorkspaceOperationOriginalDeleteDomain(access: WorkspaceOperationJobLifecycleAccess,
  input: Readonly<{ binding: WorkspaceOperationBatchClaimBinding; evidenceContext: WorkspaceOperationOriginalDeleteEvidenceContext;
    originalDurable: WorkspaceOperationOriginalDeleteIntent; originalIntent: OriginalIntent;
    prepared: PreparedWorkspaceSingleFileTrash; physical: PreparedSingleFileTrashReceipt }>
): Promise<WorkspaceOperationOriginalDeleteResult> {
  type DeleteDomainTimingStage = 'enter' | 'before-intent-parse' | 'intent-parsed' | 'before-writers' | 'writers-checked' | 'before-observation' | 'before-plan-check' | 'plan-checked' | 'before-prior-receipt' | 'prior-receipt-checked' | 'links-applied' | 'archive-returned' | 'share-applied' | 'final-graph-checked' | 'annotations-removed' | 'trash-inserted' | 'physical-receipt-written' | 'completion-prepared' | 'before-completion-receipt' | 'completion-receipt-written' | 'final-checks-done' | 'before-result-validation';
  let deleteDomainStartedAt = 0, deleteDomainLastStage: DeleteDomainTimingStage = 'enter';
  const deleteDomainMilestones: { stage: DeleteDomainTimingStage; elapsedMs: number }[] = [];
  const markDeleteDomain = (stage: DeleteDomainTimingStage) => {
    try {
      deleteDomainLastStage = stage;
      const now = performance.now();
      if (stage === 'enter') deleteDomainStartedAt = now;
      deleteDomainMilestones.push({ stage, elapsedMs: Math.round(now - deleteDomainStartedAt) });
    } catch { /* Timing diagnostics never replace the original operation result. */ }
  };
  try {
    markDeleteDomain('enter');
    const { binding, evidenceContext, originalDurable, originalIntent, prepared, physical } = input;
    const schema = binding.source.schemaName, prefix = quote(schema);
    const current = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
    if (!current || !equal(current, originalDurable) || !equal(physical.original, originalIntent.physical)) fail('ORIGINAL_DELETE_CHANGED');
    markDeleteDomain('before-intent-parse');
    parseIntent(current, evidenceContext, access.workspace, resolveWorkspaceDataRoot());
    markDeleteDomain('intent-parsed');
    markDeleteDomain('before-writers');
    await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
    for (const item of originalIntent.nativeLinks ?? []) await assertNoCompetingWriter(access, prefix, item.prepared.source.path);
    markDeleteDomain('writers-checked');
    // Retain actual pre-archive facts on this same B2. The active catalogue
    // omits the target after archive; no missing row may be reconstructed from
    // a partial native binding or from a later document at the same path.
    markDeleteDomain('before-observation');
    const beforeObservation = binding.plan.version === 2 ? await access.readOriginalNativeDeleteSources() : null;
    markDeleteDomain('before-plan-check');
    if (binding.plan.version === 2 && beforeObservation) assertWorkspaceOperationNativeDeleteBatchPlanCurrent(binding.plan,
      beforeObservation, originalIntent.jobScope);
    markDeleteDomain('plan-checked');
    if (!originalIntent.native) await assertStillPhysical(access, prefix, originalIntent.physical.canonicalPath);
    markDeleteDomain('before-prior-receipt');
    const prior = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
    if (prior) fail('ORIGINAL_DELETE_UNPROVEN');
    markDeleteDomain('prior-receipt-checked');
    const nativeLinks = (originalIntent.version === 2 || originalIntent.version === 3 || originalIntent.version === 4 || originalIntent.version === 5 || originalIntent.version === 6) && originalIntent.nativeLinks?.length
      ? await access.applyOriginalNativeDeleteLinks(current.intentDigest) : [];
    markDeleteDomain('links-applied');
    const native = originalIntent.native ? originalIntent.version === 6
      ? await access.archiveOriginalNativeHtmlDeleteTarget(current.intentDigest)
      : await archiveOriginalNativeDeleteTargetOnConnection(access.database,
        { schema, workspace: access.workspace, expected: originalIntent.native, trashEntryId: originalIntent.physical.trashEntryId,
          archivedAt: originalIntent.physical.deletedAtMs }) : null;
    markDeleteDomain('archive-returned');
    const publicShare = await applyOriginalDeletePublicShareOnConnection(access.database,
      { schema, workspace: access.workspace, original: originalIntent.publicShare, nowMs: originalIntent.physical.deletedAtMs });
    markDeleteDomain('share-applied');
    if (binding.plan.version === 2 && binding.plan.planIdentityVersion === 4) {
      if (originalIntent.version !== 6 || !beforeObservation) fail('ORIGINAL_DELETE_UNPROVEN');
      assertOriginalDeleteNativeHtmlLinkReceiptsV4(nativeLinks, originalIntent.nativeLinks);
      assertOriginalDeleteHtmlFinalGraph(binding.plan, await access.readOriginalNativeDeleteSources(),
        { sourceEvidence: originalIntent.currentWitness, nativeLinks, beforeObservation });
    } else if (binding.plan.version === 2 && binding.plan.planIdentityVersion === 3) {
      if (originalIntent.version !== 5 || !beforeObservation) fail('ORIGINAL_DELETE_UNPROVEN');
      assertOriginalDeleteNativeLinkReceipts(nativeLinks, originalIntent.nativeLinks, 3);
      assertOriginalDeleteMixedFinalGraph(binding.plan, await access.readOriginalNativeDeleteSources(),
        { sourceEvidence: originalIntent.currentWitness, nativeLinks, beforeObservation });
    } else if (binding.plan.version === 2 && (originalIntent.version === 2 || originalIntent.version === 3 || originalIntent.version === 4)) {
      assertOriginalDeleteNativeLinkReceipts(nativeLinks, originalIntent.nativeLinks ?? fail('ORIGINAL_DELETE_UNPROVEN'), originalIntent.version === 2 ? undefined : 3);
      assertOriginalDeleteNativeFinalGraph(binding.plan, await access.readOriginalNativeDeleteSources(), originalIntent.version === 3 || originalIntent.version === 4
        ? { sourceEvidence: originalIntent.currentWitness, nativeLinks } : undefined);
    }
    markDeleteDomain('final-graph-checked');
    await assertPreparedWorkspaceSingleFileTrashCurrent(prepared);
    await removeOriginalDeleteAnnotations(access, prefix, originalIntent.physical.canonicalPath, prepared);
    markDeleteDomain('annotations-removed');
    await insertTrash(access, prefix, originalIntent, current.intentDigest);
    markDeleteDomain('trash-inserted');
    const trash = await insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database,
      { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(physical) });
    if (trash.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
    markDeleteDomain('physical-receipt-written');
    const value: Completion = freeze({ version: originalIntent.version, batchId: binding.batchId, intentDigest: current.intentDigest,
      trashEntryId: originalIntent.physical.trashEntryId, physical, native, publicShare, trashReceiptDigest: trash.row.receiptDigest,
      ...(originalIntent.version === 2 || originalIntent.version === 3 || originalIntent.version === 4 || originalIntent.version === 5 || originalIntent.version === 6 ? { nativeLinks } : {}) });
    markDeleteDomain('completion-prepared');
    await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
    await assertPreparedWorkspaceSingleFileTrashSourceVacant(prepared);
    markDeleteDomain('before-completion-receipt');
    const receipt = await insertWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database,
      { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(value) });
    if (receipt.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
    markDeleteDomain('completion-receipt-written');
    await access.assertCurrent();
    await assertPreparedWorkspaceSingleFileTrashCurrent(prepared);
    await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
    await assertPreparedWorkspaceSingleFileTrashSourceVacant(prepared);
    markDeleteDomain('final-checks-done');
    markDeleteDomain('before-result-validation');
    return completed(receipt.row, trash.row, current, originalIntent);
  } finally {
    try { console.info('[File action owner] Delete B2 domain timings.', JSON.stringify({ version: 1,
      elapsedMs: Math.round(performance.now() - deleteDomainStartedAt), lastStage: deleteDomainLastStage,
      milestones: deleteDomainMilestones })); }
    catch { /* Timing diagnostics never replace the original operation result. */ }
  }
}
