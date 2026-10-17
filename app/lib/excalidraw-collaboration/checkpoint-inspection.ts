import 'server-only';

import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { SqlConnection } from '@/app/lib/db';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { assertWorkspacePathHasNoAliases, resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import type { PersistedExcalidrawScene } from './repository';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';
import { captureExcalidrawVersion } from './version-history';

export class ExcalidrawCheckpointInspectionError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export type ExcalidrawCheckpointInspection = { state: PersistedExcalidrawScene; ownPublicationPending: boolean };
type ObservedFile = { bytes: Buffer; hash: string; identity: BigIntStats } | { error: string; identity?: BigIntStats };

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readCheckpoint(workspace: WorkspaceContext, path: string): Promise<ObservedFile> {
  try {
    await assertWorkspacePathHasNoAliases(workspace, path, { readOnly: true });
    const absolutePath = resolveWorkspacePath(workspace, path).absolutePath;
    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return { error: 'The portable Excalidraw checkpoint is not a regular file.', identity: before };
      if (before.size > BigInt(EXCALIDRAW_PORTABLE_MAX_BYTES)) return {
        error: 'The portable Excalidraw checkpoint exceeds the 50 MiB limit. Its bytes have not been imported.', identity: before };
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= EXCALIDRAW_PORTABLE_MAX_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, EXCALIDRAW_PORTABLE_MAX_BYTES + 1 - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        size += bytesRead;
      }
      if (size > EXCALIDRAW_PORTABLE_MAX_BYTES) return {
        error: 'The portable Excalidraw checkpoint exceeds the 50 MiB limit. Its bytes have not been imported.', identity: before };
      const after = await handle.stat({ bigint: true });
      await assertWorkspacePathHasNoAliases(workspace, path, { readOnly: true });
      const published = await stat(absolutePath, { bigint: true });
      await assertWorkspacePathHasNoAliases(workspace, path, { readOnly: true });
      if (!sameFile(before, after) || !sameFile(after, published) || BigInt(size) !== after.size) return {
        error: 'The portable Excalidraw checkpoint changed while its bytes were inspected. Read the document again.', identity: published };
      const bytes = Buffer.concat(chunks, size);
      return { bytes, hash: createHash('sha256').update(bytes).digest('hex'), identity: after };
    } finally { await handle.close(); }
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'The portable Excalidraw checkpoint is missing. Restore the checkpoint through the document service.'
      : 'The portable Excalidraw checkpoint could not be safely inspected. Restore it or retry the read.' };
  }
}

async function assertIdentity(transaction: SqlConnection, workspace: WorkspaceContext, state: PersistedExcalidrawScene) {
  if (state.status !== 'active' || state.workspaceId !== workspace.workspaceId
    || state.organizationId !== (workspace.organizationId ?? null)) throw new ExcalidrawCheckpointInspectionError(
    'EXCALIDRAW_LIFECYCLE_STALE', 409, 'The scene identity changed. Read the current document again.');
  const identity = await transaction.get(`SELECT document.id,document.snapshot_revision_id FROM collaboration_documents document
    JOIN file_collaboration_lineages lineage ON lineage.id=document.lineage_id AND lineage.workspace_id=document.workspace_id
      AND lineage.path=document.path AND lineage.status='active'
    JOIN collaboration_excalidraw_states state ON state.document_id=document.id AND state.workspace_id=document.workspace_id
      AND state.path=document.path AND state.status='active'
    WHERE document.id=$1 AND document.workspace_id=$2 AND document.path=$3 AND document.status='active'
      AND document.provider='excalidraw' AND document.organization_id IS NOT DISTINCT FROM $4
      AND state.organization_id IS NOT DISTINCT FROM $4 AND state.lifecycle_generation=$5 AND state.scene_sequence=$6
    FOR UPDATE OF document,lineage`, [state.documentId,workspace.workspaceId,state.path,workspace.organizationId ?? null,
    state.lifecycleGeneration,state.sceneSequence]) as { id: string; snapshot_revision_id: string | null } | undefined;
  if (!identity) throw new ExcalidrawCheckpointInspectionError('EXCALIDRAW_LIFECYCLE_STALE', 409,
    'The scene identity changed. Read the current document again.');
  return identity;
}

/** Caller owns the workspace kernel fence and the scene transaction/row lock. Never publishes portable bytes. */
export async function inspectExcalidrawCheckpoint(transaction: SqlConnection, input: {
  workspace: WorkspaceContext; state: PersistedExcalidrawScene;
  beforeInspect?: () => Promise<void>;
}): Promise<ExcalidrawCheckpointInspection> {
  const { workspace, state } = input;
  const identity = await assertIdentity(transaction, workspace, state);
  const observed = await readCheckpoint(workspace, state.path);
  // The final trusted authority check follows every identity lock and awaited
  // filesystem observation, before bytes can affect metadata/history or output.
  await input.beforeInspect?.();
  const ownIntent = 'hash' in observed ? await transaction.get(`SELECT scene_sequence FROM collaboration_excalidraw_checkpoint_intents
    WHERE document_id=$1 AND lifecycle_generation=$2 AND scene_sequence<=$3 AND content_hash=$4
      AND file_dev=$5 AND file_ino=$6 LIMIT 1`, [state.documentId,state.lifecycleGeneration,state.sceneSequence,
    observed.hash,String(observed.identity.dev),String(observed.identity.ino)]) : null;
  const pendingRestore = await transaction.get(`SELECT approved_file_hash,approved_file_dev,approved_file_ino
    FROM collaboration_excalidraw_restores WHERE document_id=$1 AND workspace_id=$2 AND lifecycle_generation=$3
      AND checkpoint_completed=false AND scene_sequence<=$4 ORDER BY scene_sequence DESC,created_at DESC LIMIT 1`,
  [state.documentId,workspace.workspaceId,state.lifecycleGeneration,state.sceneSequence]) as {
    approved_file_hash: string | null; approved_file_dev: string | null; approved_file_ino: string | null;
  } | undefined;
  const approvedRestoreBaseline = pendingRestore && 'hash' in observed
    && pendingRestore.approved_file_hash === observed.hash
    && pendingRestore.approved_file_dev === String(observed.identity.dev)
    && pendingRestore.approved_file_ino === String(observed.identity.ino);
  const pendingCreate = await transaction.get(`SELECT file_dev,file_ino FROM collaboration_excalidraw_creates
    WHERE workspace_id=$1 AND document_id=$2 AND status='preparing' LIMIT 1`,
  [workspace.workspaceId,state.documentId]) as { file_dev: string | null; file_ino: string | null } | undefined;
  if (pendingCreate && !ownIntent && (!observed.identity || pendingCreate.file_dev !== String(observed.identity.dev)
    || pendingCreate.file_ino !== String(observed.identity.ino))) throw new ExcalidrawCheckpointInspectionError(
    'PATH_EXISTS', 409, 'The interrupted creation no longer owns this file. Its replacement has been preserved.');
  let reason: string | undefined = 'error' in observed ? observed.error : undefined;
  let foreignBytes: Buffer | undefined;
  if ('hash' in observed && !ownIntent && !approvedRestoreBaseline) {
    let expectedHash = state.checkpointContentHash;
    const revisionId = state.checkpointRevisionId ?? identity.snapshot_revision_id;
    if (!expectedHash && revisionId) {
      const revision = await transaction.get('SELECT content_hash FROM file_revisions WHERE id=$1 AND workspace_id=$2',
        [revisionId,workspace.workspaceId]) as { content_hash: string } | undefined;
      expectedHash = revision?.content_hash ?? null;
    }
    if (pendingRestore || expectedHash && observed.hash !== expectedHash) {
      foreignBytes = observed.bytes;
      reason = 'The portable Excalidraw file changed outside the scene service. Its bytes were preserved in version history; import or restore it explicitly.';
    } else if (!expectedHash) reason = 'The portable Excalidraw checkpoint has no verifiable saved version. Restore it through the document service.';
  }
  if (reason) {
    // Validate the same active generation and sequence after awaited filesystem
    // observation and before any history/degraded metadata can be changed.
    await assertIdentity(transaction, workspace, state);
    if (foreignBytes) {
      await transaction.run('SAVEPOINT excalidraw_checkpoint_inspection_history');
      try { await captureExcalidrawVersion({ workspace, path: state.path, content: foreignBytes,
        source: 'external_import', historyOnly: true, transaction }); }
      catch {
        await transaction.run('ROLLBACK TO SAVEPOINT excalidraw_checkpoint_inspection_history');
        reason = 'The portable Excalidraw file changed outside the scene service. Its file bytes remain untouched, but its history copy could not be saved. Restore it or retry the read.';
      }
      await transaction.run('RELEASE SAVEPOINT excalidraw_checkpoint_inspection_history');
    }
    // Storage capture can wait on workspace/lineage quota locks. Denial here
    // must escape the savepoint catch and roll back its entire outer transaction.
    await input.beforeInspect?.();
    await transaction.run(`UPDATE collaboration_excalidraw_states SET degraded_reason=$1
      WHERE document_id=$2 AND workspace_id=$3 AND path=$4 AND organization_id IS NOT DISTINCT FROM $5
        AND lifecycle_generation=$6 AND scene_sequence=$7 AND status='active'`,
    [reason,state.documentId,workspace.workspaceId,state.path,workspace.organizationId ?? null,state.lifecycleGeneration,state.sceneSequence]);
    return { state: { ...state, degradedReason: reason }, ownPublicationPending: false };
  }
  await input.beforeInspect?.();
  return { state, ownPublicationPending: Boolean(ownIntent || approvedRestoreBaseline) };
}
