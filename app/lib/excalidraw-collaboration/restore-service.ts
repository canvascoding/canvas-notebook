import 'server-only';

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { readFile, resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { FILE_VERSION_CENTER_CONTRACT_VERSION, FILE_VERSION_CENTER_ERROR_CODES, FileVersionCenterContractError,
  parseFileVersionRestoreResponseV1, type FileVersionRestoreRequestV1,
  type FileVersionRestoreResponseV1 } from '@/app/lib/file-version-center/contracts/v1';
import type { ResolvedFileVersionTarget } from '@/app/lib/file-version-center/query-service';
import { fileVersionFencesMatch } from '@/app/lib/file-version-center/authoritative-content';
import { assertPortableExcalidrawAssetBindings, importPortableExcalidrawAssets } from './assets';
import { authoritativeExcalidrawVersionContent } from './authoritative-content';
import { materializeExcalidrawCheckpoint } from './checkpoint';
import { validatePortableExcalidrawScene } from './portable-import';
import { assertExcalidrawProviderAvailable } from './provider';
import { loadExcalidrawSceneInTransaction, withExcalidrawSceneTransaction } from './repository';
import { canonicalSceneHash } from './scene';
import { excalidrawDocumentSnapshot } from './scene-service';
import { captureExcalidrawVersion, createExcalidrawVersionContentStore, MAX_PORTABLE_EXCALIDRAW_BYTES } from './version-history';

type RestoreReceipt = {
  document_id: string; lineage_id: string; request_fingerprint: string;
  target_revision_id: string; prior_revision_id: string; restored_revision_id: string;
  lifecycle_generation: string | number; scene_sequence: string | number; canonical_hash: string;
};

function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function assertAuthority(current: WorkspaceContext, initial: WorkspaceContext, userId: string): void {
  if (!userId || current.workspaceId !== initial.workspaceId || current.rootPath !== initial.rootPath
    || (current.organizationId ?? null) !== (initial.organizationId ?? null) || current.legacy
    || current.status !== undefined && current.status !== 'active'
    || !current.permissions.canRead || !current.permissions.canWrite
    || current.actor && current.actor.userId !== userId) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
      'Current authenticated workspace write permission is required for Excalidraw restore.');
  }
}

/** A generation change, immutable version and publication authority are committed together. */
export async function restoreExcalidrawVersion(input: {
  target: ResolvedFileVersionTarget; request: FileVersionRestoreRequestV1; workspace: WorkspaceContext;
  userId: string; actorSessionId?: string | null; beforeApply?: () => Promise<WorkspaceContext>;
}): Promise<FileVersionRestoreResponseV1> {
  try { await assertExcalidrawProviderAvailable(); } catch {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
      'PostgreSQL is required for Excalidraw restore.');
  }
  assertAuthority(input.workspace, input.workspace, input.userId);
  const { target, request } = input;
  if (!target.documentId || target.workspaceId !== input.workspace.workspaceId) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.notFound,
      'The Excalidraw version target has no active scene identity.');
  }
  const selected = await createExcalidrawVersionContentStore().readRevisionContent({
    revisionId: request.revisionId, workspaceId: target.workspaceId, lineageId: target.lineageId,
  });
  if (!selected || selected.binding.format !== 'text') throw new FileVersionCenterContractError(
    FILE_VERSION_CENTER_ERROR_CODES.contentUnavailable, 'The selected immutable Excalidraw version is unavailable.');
  const content = selected.content.toString('utf8');
  if (!Buffer.from(content).equals(selected.content)) throw new FileVersionCenterContractError(
    FILE_VERSION_CENTER_ERROR_CODES.contentUnavailable, 'The selected Excalidraw version is not valid UTF-8.');
  let portable: ReturnType<typeof validatePortableExcalidrawScene>;
  try { portable = validatePortableExcalidrawScene(content); }
  catch { throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.contentUnavailable,
    'The selected immutable version is not a valid portable Excalidraw scene.'); }
  const actorId = `fvrc-user:${input.userId}`;
  const fingerprint = hash(JSON.stringify({ documentId: target.documentId, lineageId: target.lineageId,
    targetRevisionId: request.revisionId, expectedCurrent: request.expectedCurrent }));
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    let workspace = input.workspace;
    const committed = await withExcalidrawSceneTransaction(target.documentId!, async transaction => {
      const state = await loadExcalidrawSceneInTransaction(transaction, target.documentId!, false, true);
      workspace = await input.beforeApply?.() ?? input.workspace;
      assertAuthority(workspace, input.workspace, input.userId);
      const identity = await transaction.get(`SELECT document.id FROM collaboration_documents document
        JOIN file_collaboration_lineages lineage ON lineage.id=document.lineage_id AND lineage.status='active'
        WHERE document.id=$1 AND document.workspace_id=$2 AND document.lineage_id=$3
          AND document.provider='excalidraw' AND document.status='active' AND document.path=$4 FOR UPDATE OF document,lineage`,
      [target.documentId, target.workspaceId, target.lineageId, state?.path ?? target.path]);
      if (!state || !identity || state.workspaceId !== workspace.workspaceId
        || state.organizationId !== (workspace.organizationId ?? null)) throw new FileVersionCenterContractError(
        FILE_VERSION_CENTER_ERROR_CODES.staleCurrent, 'The Excalidraw document lifecycle changed. Reload its history.');
      const receipt = await transaction.get(`SELECT * FROM collaboration_excalidraw_restores
        WHERE workspace_id=$1 AND actor_user_id=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,
      [workspace.workspaceId, input.userId, actorId, request.idempotencyKey]) as RestoreReceipt | undefined;
      if (receipt) {
        if (receipt.request_fingerprint !== fingerprint || receipt.document_id !== state.documentId
          || receipt.lineage_id !== target.lineageId || receipt.target_revision_id !== request.revisionId) {
          throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.conflict,
            'This Excalidraw restore key belongs to a different request.');
        }
        return { duplicate: true, receipt, state };
      }
      if (state.path !== target.path) throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.staleCurrent,
        'The Excalidraw path changed. Reload its history.');
      const current = await authoritativeExcalidrawVersionContent(transaction, state, target.lineageId);
      if (!fileVersionFencesMatch(current.fence, request.expectedCurrent)) throw new FileVersionCenterContractError(
        FILE_VERSION_CENTER_ERROR_CODES.staleCurrent, 'The Excalidraw scene changed. Reload its history before restoring.');
      await assertPortableExcalidrawAssetBindings(workspace.workspaceId, portable.assets);
      // Secure the exact external baseline before the receipt can authorize its replacement.
      let approvedHash: string | null = null;
      let approvedDev: string | null = null;
      let approvedIno: string | null = null;
      try {
        const absolute = await resolveExistingWorkspacePath(state.path, workspaceFileOptions(workspace));
        const before = await stat(absolute, { bigint: true });
        if (before.size > BigInt(MAX_PORTABLE_EXCALIDRAW_BYTES)) throw new FileVersionCenterContractError(
          FILE_VERSION_CENTER_ERROR_CODES.contentUnavailable, 'The external Excalidraw file exceeds the portable scene limit.');
        const bytes = await readFile(state.path, workspaceFileOptions(workspace));
        const after = await stat(absolute, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new FileVersionCenterContractError(
          FILE_VERSION_CENTER_ERROR_CODES.staleCurrent, 'The portable Excalidraw file changed while restore was prepared.');
        approvedHash = hash(bytes); approvedDev = String(before.dev); approvedIno = String(before.ino);
        if (approvedHash !== state.checkpointContentHash) await captureExcalidrawVersion({ workspace, path: state.path,
          content: bytes, source: 'external_import', historyOnly: true, transaction });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const prior = await captureExcalidrawVersion({ workspace, path: state.path, content: current.content,
        source: 'manual', actorUserId: input.userId, actorType: 'user', sourceSessionId: input.actorSessionId, transaction });
      const assets = await importPortableExcalidrawAssets({ workspaceId: workspace.workspaceId, content });
      const canonical = canonicalSceneHash({ elements: portable.elements, appState: portable.appState, assets });
      const restored = await captureExcalidrawVersion({ workspace, path: state.path, content: selected.content,
        source: 'restore', actorUserId: input.userId, actorType: 'user', sourceSessionId: input.actorSessionId,
        forceNewRevision: true, transaction });
      const generation = state.lifecycleGeneration + 1;
      const sequence = state.sceneSequence + 1;
      const timestamp = Date.now();
      await transaction.run(`UPDATE collaboration_excalidraw_states SET elements_json=$1,shared_app_state_json=$2,
        assets_json=$3,canonical_hash=$4,lifecycle_generation=$5,scene_sequence=$6,persisted_at=$7,degraded_reason=NULL
        WHERE document_id=$8 AND lifecycle_generation=$9 AND status='active'`,
      [JSON.stringify(portable.elements), JSON.stringify(portable.appState), JSON.stringify(assets), canonical,
        generation, sequence, timestamp, state.documentId, state.lifecycleGeneration]);
      await transaction.run(`UPDATE collaboration_excalidraw_agent_operations SET status='cancelled',
        review_reason='The Excalidraw document was restored to a new lifecycle.', updated_at=$1, cas_version=cas_version+1
        WHERE document_id=$2 AND lifecycle_generation<$3 AND status IN ('preparing','needs_review')`,
      [timestamp, state.documentId, generation]);
      await transaction.run(`INSERT INTO collaboration_excalidraw_restores
        (workspace_id,actor_user_id,actor_id,idempotency_key,request_fingerprint,document_id,lineage_id,target_revision_id,
          prior_revision_id,restored_revision_id,lifecycle_generation,scene_sequence,canonical_hash,
          approved_file_hash,approved_file_dev,approved_file_ino,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [workspace.workspaceId,input.userId,actorId,request.idempotencyKey,fingerprint,state.documentId,target.lineageId,
        request.revisionId,prior.revisionId,restored.revisionId,generation,sequence,canonical,approvedHash,approvedDev,approvedIno,timestamp]);
      await transaction.run(`SELECT pg_notify('canvas_excalidraw_scene',$1)`,
        [JSON.stringify({ documentId: state.documentId, sceneSequence: sequence })]);
      const updated = await loadExcalidrawSceneInTransaction(transaction, state.documentId, false, true);
      if (!updated) throw new Error('The restored Excalidraw state is unavailable.');
      return { duplicate: false, state: updated, receipt: { document_id: state.documentId,
        lineage_id: target.lineageId,request_fingerprint:fingerprint,target_revision_id:request.revisionId,
        prior_revision_id:prior.revisionId,restored_revision_id:restored.revisionId,lifecycle_generation:generation,
        scene_sequence:sequence,canonical_hash:canonical } satisfies RestoreReceipt };
    });
    // The scene commit remains authoritative if filesystem publication needs recovery.
    await materializeExcalidrawCheckpoint({ state: committed.state, workspace, actorUserId: input.userId,
      actorType: 'user', sourceSessionId: input.actorSessionId, beforePublish: async () => {
        const refreshed = await input.beforeApply?.() ?? workspace;
        assertAuthority(refreshed, input.workspace, input.userId);
      } }).catch(() => undefined);
    return withExcalidrawSceneTransaction(committed.state.documentId, async transaction => {
      const state = await loadExcalidrawSceneInTransaction(transaction, committed.state.documentId, false, true);
      if (!state) throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
        'The committed restored scene is unavailable.');
      const current = await authoritativeExcalidrawVersionContent(transaction, state, target.lineageId);
      return parseFileVersionRestoreResponseV1({ contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        outcome: committed.duplicate ? 'already_restored' : 'restored', priorRevisionId: committed.receipt.prior_revision_id,
        restoredRevisionId: committed.receipt.restored_revision_id, current: current.fence,
        lifecycleGeneration: state.lifecycleGeneration, sceneSequence: state.sceneSequence,
        checkpoint: excalidrawDocumentSnapshot(state).checkpoint });
    });
  });
}
