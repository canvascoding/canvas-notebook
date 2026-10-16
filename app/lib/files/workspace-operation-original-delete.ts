import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { openDb, type SqlConnection } from '../db';
import { authoritativeCollaborationSnapshot } from '../collaboration/checkpoint';
import { serializeCanonicalText } from '../collaboration/persistence';
import { prepareNativeFileArchiveTransition, type NativeFileArchiveExpected,
  type NativeFileArchiveTransition } from '../collaboration/native-file-archive-transition';
import { readWorkspaceDocumentCatalogue } from '../collaboration/workspace-document-catalogue';
import { resolveWorkspaceDataRoot } from '../workspaces/context';
import type { WorkspaceContext } from '../workspaces/types';
import { withPreparedWorkspaceSingleFileTrash, withRecoveredWorkspaceSingleFileTrash,
  readPreparedWorkspaceSingleFileTrash, movePreparedWorkspaceSingleFileTrash,
  assertPreparedWorkspaceSingleFileTrashCurrent,
  type PreparedWorkspaceSingleFileTrash, type PreparedSingleFileTrashOriginalFacts,
  type PreparedSingleFileTrashReceipt } from '../filesystem/prepared-single-file-trash';
import { computeWorkspaceOperationBatchPlanId } from './workspace-operation-batch-plan';
import { readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from './workspace-operation-batch-store';
import { captureWorkspaceOperationJobScope, workspaceOperationJobScopeMatches } from './workspace-operation-job-scope';
import { withWorkspaceOperationJobLifecycleOwner, withWorkspaceOperationJobLifecycleTransaction,
  type WorkspaceOperationJobLifecycleAccess } from './workspace-operation-job-lifecycle-owner';
import { readOriginalNativeDeleteTargetOnConnection, archiveOriginalNativeDeleteTargetOnConnection } from './workspace-operation-original-delete-native';
import { captureOriginalDeletePublicShareOnConnection, assertOriginalDeletePublicShareOnConnection, applyOriginalDeletePublicShareOnConnection,
  type OriginalDeletePublicShare, type OriginalDeletePublicShareResult } from './workspace-operation-original-delete-public';
import { readWorkspaceOperationOriginalDeleteIntentOnConnection, readWorkspaceOperationOriginalDeleteReceiptOnConnection,
  readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection, insertWorkspaceOperationOriginalDeleteIntentOnConnection,
  insertWorkspaceOperationOriginalDeleteReceiptOnConnection, insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection,
  type WorkspaceOperationOriginalDeleteIntent, type WorkspaceOperationOriginalDeleteReceipt } from './workspace-operation-original-delete-repository';

type Row = Record<string, unknown>;
type OriginalIntent = Readonly<{
  version: 1; batchId: string; planId: string; requestHash: string;
  actor: Readonly<{ userId: string; actorId: string; actorType: 'user' | 'agent'; actorSessionId: string | null }>;
  jobScope: ReturnType<typeof captureWorkspaceOperationJobScope>;
  physical: PreparedSingleFileTrashOriginalFacts; native: NativeFileArchiveExpected | null;
  publicShare: OriginalDeletePublicShare | null;
}>;
type Completion = Readonly<{
  version: 1; batchId: string; intentDigest: string; trashEntryId: string;
  physical: PreparedSingleFileTrashReceipt; native: NativeFileArchiveTransition | null;
  publicShare: OriginalDeletePublicShareResult; trashReceiptDigest: string;
}>;
export type WorkspaceOperationOriginalDeleteResult = Readonly<Completion & { receiptDigest: string }>;
export class WorkspaceOperationOriginalDeleteError extends Error {
  readonly status = 409;
  constructor(readonly code: 'ORIGINAL_DELETE_INVALID' | 'ORIGINAL_DELETE_CHANGED' | 'ORIGINAL_DELETE_BUSY'
    | 'ORIGINAL_DELETE_UNSUPPORTED' | 'ORIGINAL_DELETE_UNPROVEN' | 'ORIGINAL_DELETE_POSTCONDITION') {
    super(code); this.name = 'WorkspaceOperationOriginalDeleteError';
  }
}
function fail(code: WorkspaceOperationOriginalDeleteError['code']): never { throw new WorkspaceOperationOriginalDeleteError(code); }
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const json = (value: unknown): string => JSON.stringify(value);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function object(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('ORIGINAL_DELETE_UNPROVEN');
  return value as Row;
}

function selection(claim: WorkspaceOperationBatchClaim): WorkspaceOperationBatchClaimBinding {
  const binding = readWorkspaceOperationBatchClaimBinding(claim), { plan, authorization } = binding;
  const step = plan.pathSteps[0], action = plan.actions[0], deleted = plan.deletedPaths[0];
  if (binding.actionMode !== 'apply' || authorization.mode !== 'direct' || !authorization.jobScope
    || authorization.jobScope.legacy || plan.version !== 1 || plan.readiness !== 'ready' || plan.issues.length
    || plan.workspaceId !== binding.workspaceId || plan.planId !== binding.planId
    || computeWorkspaceOperationBatchPlanId(plan) !== binding.planId || plan.pathSteps.length !== 1
    || step.kind !== 'delete' || step.destinationPath !== undefined || plan.actions.length !== 1
    || action.kind !== 'delete' || action.reviewId !== step.reviewId || action.selections.length !== 1
    || action.selections[0].sourcePath !== step.sourcePath || action.selections[0].destinationPath !== undefined
    || plan.deletedPaths.length !== 1 || deleted.kind !== 'file' || deleted.path !== step.sourcePath
    || plan.pathMappings.length || plan.linkEdits.length || plan.originalDocuments.length || plan.previewContents.length
    || !plan.coverage.complete || !plan.linkAssessment.complete || plan.linkAssessment.blockers.length) fail('ORIGINAL_DELETE_UNSUPPORTED');
  return binding;
}
function actor(binding: WorkspaceOperationBatchClaimBinding): OriginalIntent['actor'] {
  const auth = binding.authorization; if (auth.mode !== 'direct') fail('ORIGINAL_DELETE_INVALID');
  return Object.freeze({ userId: auth.actorUserId, actorId: auth.actorId, actorType: auth.actorType, actorSessionId: auth.actorSessionId ?? null });
}
function parseIntent(row: WorkspaceOperationOriginalDeleteIntent, binding: WorkspaceOperationBatchClaimBinding,
  workspace: WorkspaceContext): OriginalIntent {
  const auth = binding.authorization; if (auth.mode !== 'direct') fail('ORIGINAL_DELETE_INVALID');
  const value = object(JSON.parse(row.intentText), ['version', 'batchId', 'planId', 'requestHash', 'actor', 'jobScope', 'physical', 'native', 'publicShare']);
  if (value.version !== 1 || row.batchId !== binding.batchId || value.batchId !== binding.batchId
    || row.planId !== binding.planId || value.planId !== binding.planId || row.workspaceId !== binding.workspaceId
    || row.requestHash !== auth.requestHash || value.requestHash !== auth.requestHash || !equal(value.actor, actor(binding))
    || !equal(value.jobScope, auth.jobScope) || !workspaceOperationJobScopeMatches(value.jobScope, workspace)) fail('ORIGINAL_DELETE_UNPROVEN');
  const physical = value.physical as OriginalIntent['physical'];
  if (!physical || physical.version !== 1 || physical.canonicalPath !== binding.plan.pathSteps[0].sourcePath
    || physical.workspace.workspaceId !== binding.workspaceId || physical.workspace.rootPath !== workspace.rootPath
    || physical.workspace.dataRoot !== resolveWorkspaceDataRoot() || !/^trash-[0-9a-f-]{36}$/u.test(physical.trashEntryId)) fail('ORIGINAL_DELETE_UNPROVEN');
  const native = value.native as NativeFileArchiveExpected | null;
  if (native !== null && (native.workspaceId !== workspace.workspaceId || native.organizationId !== (workspace.organizationId ?? null)
    || native.path !== physical.canonicalPath)) fail('ORIGINAL_DELETE_UNPROVEN');
  if (physical.source.kind === 'projection_absent' && native === null) fail('ORIGINAL_DELETE_UNPROVEN');
  return freeze(value) as OriginalIntent;
}

async function assertNoCompetingWriter(access: WorkspaceOperationJobLifecycleAccess, prefix: string, source: string): Promise<void> {
  // This first closed runner does not adopt/release another writer's lock or a
  // Guest lifecycle. Those cases remain explicit unsupported/busy outcomes.
  const locks = await access.database.all(`SELECT id FROM ${prefix}.file_locks WHERE workspace_id=$1 AND path=$2
    AND status='active' AND expires_at>$3 FOR SHARE NOWAIT`, [access.workspace.workspaceId, source, Date.now()]);
  const guests = await access.database.all(`SELECT id FROM ${prefix}.file_guest_invitations WHERE workspace_id=$1 AND path=$2
    AND status='active' FOR SHARE NOWAIT`, [access.workspace.workspaceId, source]);
  if (locks.length || guests.length) fail('ORIGINAL_DELETE_BUSY');
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
  native: NativeFileArchiveExpected | null, nativeContentHash: string | null): void {
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
  const catalogue = await readWorkspaceDocumentCatalogue(access.database, access.workspace, { paths: [source], maxEntries: 2 });
  if (catalogue.some(entry => entry.path !== source) || catalogue.length > 1) fail('ORIGINAL_DELETE_UNSUPPORTED');
  let native: NativeFileArchiveExpected | null = null, nativeContentHash: string | null = null;
  if (catalogue.length) {
    const entry = catalogue[0];
    if (entry.authority !== 'initialized' || !entry.lineage_id) fail('ORIGINAL_DELETE_UNSUPPORTED');
    const original = await readOriginalNativeDeleteTargetOnConnection(access.database,
      { schema, workspace: access.workspace, documentId: entry.id, lineageId: entry.lineage_id, path: source });
    native = original.expected;
    // Native archive authority does not require a lossless Markdown export.
    // Export only when this particular stored plan actually demands that hash.
    const requiresNativeContent = binding.plan.expectedPathState.some(expected => expected.contentHash !== null
      && (physical.source.kind !== 'regular_file' || expected.contentHash !== physical.source.sha256));
    if (requiresNativeContent) nativeContentHash = digest(serializeCanonicalText(
      authoritativeCollaborationSnapshot(original.state).canonicalContent, original.state));
    // Reject archive limits/quarantine before making the physical transition.
    prepareNativeFileArchiveTransition(original.state, native, { trashEntryId: physical.trashEntryId, archivedAt: physical.deletedAtMs });
  } else if (await access.database.get(`SELECT id FROM ${prefix}.file_collaboration_lineages WHERE workspace_id=$1
    AND path=$2 AND status='active' LIMIT 1 FOR SHARE NOWAIT`, [binding.workspaceId, source])) fail('ORIGINAL_DELETE_UNSUPPORTED');
  assertPlanSource(binding, physical, native, nativeContentHash);
  const publicShare = await captureOriginalDeletePublicShareOnConnection(access.database,
    { schema, workspace: access.workspace, path: source, ...(native ? { nativeExpected: native } : {}) });
  const auth = binding.authorization; if (auth.mode !== 'direct' || !auth.jobScope) fail('ORIGINAL_DELETE_INVALID');
  return freeze({ version: 1, batchId: binding.batchId, planId: binding.planId, requestHash: auth.requestHash,
    actor: actor(binding), jobScope: auth.jobScope, physical, native, publicShare });
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
  if (!row || row.id !== physical.trashEntryId || row.organization_id !== jobScope.organizationId || row.customer_id !== jobScope.customerId
    || row.project_id !== jobScope.projectId || row.workspace_id !== jobScope.workspaceId || row.workspace_type !== jobScope.workspaceType
    || row.owner_user_id !== jobScope.ownerUserId || row.original_path !== physical.canonicalPath || row.trash_relative_path !== physical.trashRelativePath
    || row.entry_name !== path.posix.basename(physical.canonicalPath) || row.item_type !== 'file' || Number(row.size_bytes) !== size
    || Number(row.file_count) !== 1 || Number(row.directory_count) !== 0 || row.status !== 'trashed'
    || row.deleted_by_user_id !== intent.actor.userId || Number(row.deleted_at) !== physical.deletedAtMs || Number(row.expires_at) !== physical.expiresAtMs
    || row.metadata_json !== trashMetadata(intent, intentDigest)
    || ['restored_by_user_id', 'purged_by_user_id', 'restored_at', 'purged_at'].some(key => row[key] !== null)) fail('ORIGINAL_DELETE_POSTCONDITION');
}
function completed(row: WorkspaceOperationOriginalDeleteReceipt, trash: WorkspaceOperationOriginalDeleteReceipt | null,
  durable: WorkspaceOperationOriginalDeleteIntent, intent: OriginalIntent): WorkspaceOperationOriginalDeleteResult {
  const value = object(JSON.parse(row.receiptText), ['version', 'batchId', 'intentDigest', 'trashEntryId', 'physical', 'native', 'publicShare', 'trashReceiptDigest']);
  const physical = value.physical as PreparedSingleFileTrashReceipt;
  if (!trash || row.batchId !== durable.batchId || trash.batchId !== durable.batchId || row.intentDigest !== durable.intentDigest
    || trash.intentDigest !== durable.intentDigest || value.version !== 1 || value.batchId !== durable.batchId
    || value.intentDigest !== durable.intentDigest || value.trashEntryId !== intent.physical.trashEntryId
    || !physical || physical.version !== 1 || !equal(physical.original, intent.physical)
    || trash.receiptText !== json(physical) || value.trashReceiptDigest !== trash.receiptDigest
    || intent.native === null && value.native !== null || intent.native !== null
    && (!value.native || (value.native as NativeFileArchiveTransition).before.identity.documentId !== intent.native.documentId
      || (value.native as NativeFileArchiveTransition).before.identity.lineageId !== intent.native.lineageId
      || (value.native as NativeFileArchiveTransition).before.clock.stateProof !== intent.native.stateProof)) fail('ORIGINAL_DELETE_UNPROVEN');
  return freeze({ ...value, receiptDigest: row.receiptDigest }) as WorkspaceOperationOriginalDeleteResult;
}

/** Closed single-file path stage. Does not complete a batch, rewrite backlinks,
 * claim a human review, or expose Markdown/SQL writes to an agent. Not wired to
 * the general executor until native Restore and its producer contract pass. */
export async function executeWorkspaceOperationOriginalDelete(claim: WorkspaceOperationBatchClaim,
  openConnection: () => Promise<SqlConnection> = openDb): Promise<WorkspaceOperationOriginalDeleteResult> {
  const binding = selection(claim), schema = binding.source.schemaName, prefix = quote(schema);
  return withWorkspaceOperationJobLifecycleOwner(claim, async owner => {
    const observe = () => withWorkspaceOperationJobLifecycleTransaction(owner, async access => {
      const durable = await readWorkspaceOperationOriginalDeleteIntentOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      const receipt = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      const trash = await readWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
      if (!durable && (receipt || trash) || durable && !receipt && trash) fail('ORIGINAL_DELETE_UNPROVEN');
      const intent = durable ? parseIntent(durable, binding, access.workspace) : null;
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
        parseIntent(current, binding, access.workspace);
        await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
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
        parseIntent(current, binding, access.workspace);
        await assertNoCompetingWriter(access, prefix, originalIntent.physical.canonicalPath);
        if (!originalIntent.native) await assertStillPhysical(access, prefix, originalIntent.physical.canonicalPath);
        const prior = await readWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database, { schema, batchId: binding.batchId, forShare: true });
        if (prior) fail('ORIGINAL_DELETE_UNPROVEN');
        const native = originalIntent.native ? await archiveOriginalNativeDeleteTargetOnConnection(access.database,
          { schema, workspace: access.workspace, expected: originalIntent.native, trashEntryId: originalIntent.physical.trashEntryId,
            archivedAt: originalIntent.physical.deletedAtMs }) : null;
        const publicShare = await applyOriginalDeletePublicShareOnConnection(access.database,
          { schema, workspace: access.workspace, original: originalIntent.publicShare, nowMs: originalIntent.physical.deletedAtMs });
        await assertPreparedWorkspaceSingleFileTrashCurrent(prepared);
        await insertTrash(access, prefix, originalIntent, current.intentDigest);
        const trash = await insertWorkspaceOperationOriginalDeleteTrashReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(physical) });
        if (trash.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
        const value: Completion = freeze({ version: 1, batchId: binding.batchId, intentDigest: current.intentDigest,
          trashEntryId: originalIntent.physical.trashEntryId, physical, native, publicShare, trashReceiptDigest: trash.row.receiptDigest });
        const receipt = await insertWorkspaceOperationOriginalDeleteReceiptOnConnection(access.database,
          { schema, batchId: binding.batchId, intentDigest: current.intentDigest, receiptText: json(value) });
        if (receipt.kind !== 'created') fail('ORIGINAL_DELETE_UNPROVEN');
        await access.assertCurrent();
        await assertPreparedWorkspaceSingleFileTrashCurrent(prepared);
        return completed(receipt.row, trash.row, current, originalIntent);
      });
    };
    return observed.intent
      ? withRecoveredWorkspaceSingleFileTrash({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(), original: observed.intent.physical }, apply)
      : withPreparedWorkspaceSingleFileTrash({ workspace: observed.workspace, dataRoot: resolveWorkspaceDataRoot(),
        canonicalPath: binding.plan.pathSteps[0].sourcePath, trashEntryId: `trash-${randomUUID()}` }, apply);
  }, openConnection);
}
