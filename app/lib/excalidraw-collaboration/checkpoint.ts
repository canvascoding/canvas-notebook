import 'server-only';

import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { openDb } from '@/app/lib/db';
import { readFile, resolveExistingWorkspacePath, writeFile, writeFileIfAbsent } from '@/app/lib/filesystem/workspace-files';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { getWorkspaceFileRevision } from '@/app/lib/files/revision-guard';
import { EXCALIDRAW_FILE_SOURCE } from '@/app/lib/excalidraw-file';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { decodeExcalidrawDataUrl, loadExcalidrawAsset } from './assets';
import { canonicalSceneHash, sharedExcalidrawAppState, validateExcalidrawElements } from './scene';
import { loadExcalidrawSceneInTransaction, withExcalidrawSceneTransaction, type PersistedExcalidrawScene } from './repository';
import { withExcalidrawPublication } from './publication-context';
import { captureExcalidrawVersion, createExcalidrawVersionContentStore, MAX_PORTABLE_EXCALIDRAW_BYTES } from './version-history';
import { EXCALIDRAW_ASSET_MAX_BYTES } from './limits';

export class ExcalidrawCheckpointError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'ExcalidrawCheckpointError';
  }
}

export class ExcalidrawCheckpointConflictError extends ExcalidrawCheckpointError {
  constructor() {
    super('EXCALIDRAW_CHECKPOINT_CONFLICT', 409,
      'The portable Excalidraw file changed outside the scene service. Its bytes were preserved in version history; import or restore it explicitly.');
    this.name = 'ExcalidrawCheckpointConflictError';
  }
}

function sameCheckpointFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function legacyPortableSceneMatches(content: Buffer, state: PersistedExcalidrawScene): boolean {
  try {
    const portable = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
    if (portable.type !== 'excalidraw') return false;
    const elements = validateExcalidrawElements(portable.elements, 'scene');
    const appState = sharedExcalidrawAppState(portable.appState);
    const files = (portable.files ?? {}) as Record<string, { dataURL?: unknown; mimeType?: unknown; version?: unknown }>;
    if (!files || typeof files !== 'object' || Array.isArray(files)
      || Object.keys(files).length !== state.assets.length) return false;
    for (const asset of state.assets) {
      const file = files[asset.fileId];
      if (!file || typeof file.dataURL !== 'string') return false;
      const decoded = decodeExcalidrawDataUrl(file.dataURL);
      if (decoded.mimeType !== asset.mimeType || createHash('sha256').update(decoded.data).digest('hex') !== asset.contentHash
        || Number(file.version ?? 1) !== asset.version) return false;
    }
    return canonicalSceneHash({ elements, appState, assets: state.assets }) === state.canonicalHash;
  } catch { return false; }
}

export async function serializePortableExcalidrawScene(
  state: PersistedExcalidrawScene,
): Promise<string> {
  const files: Record<string, {
    id: string;
    mimeType: string;
    dataURL: string;
    created: number;
    lastRetrieved: number;
    version: number;
  }> = {};
  let base64Bytes = 0;
  // Predict the exact encoded-byte overhead before loading any image buffers.
  for (const metadata of state.assets) {
    if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1 || metadata.sizeBytes > EXCALIDRAW_ASSET_MAX_BYTES) {
      throw new ExcalidrawCheckpointError('EXCALIDRAW_ASSET_INVALID', 503, 'The stored Excalidraw asset size is invalid.');
    }
    files[metadata.fileId] = { id: metadata.fileId, mimeType: metadata.mimeType,
      dataURL: `data:${metadata.mimeType};base64,`, created: metadata.createdAt,
      lastRetrieved: metadata.createdAt, version: metadata.version };
    base64Bytes += Math.ceil(metadata.sizeBytes / 3) * 4;
    if (base64Bytes > MAX_PORTABLE_EXCALIDRAW_BYTES) throw new ExcalidrawCheckpointError(
      'EXCALIDRAW_CHECKPOINT_TOO_LARGE', 413, 'Portable Excalidraw checkpoint exceeds the 50 MiB limit.');
  }
  const scene = { type: 'excalidraw', version: 2, source: EXCALIDRAW_FILE_SOURCE,
    elements: state.elements, appState: state.appState, files };
  if (Buffer.byteLength(JSON.stringify(scene, null, 2), 'utf8') + base64Bytes > MAX_PORTABLE_EXCALIDRAW_BYTES) {
    throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_TOO_LARGE', 413, 'Portable Excalidraw checkpoint exceeds the 50 MiB limit.');
  }
  for (const metadata of state.assets) {
    const asset = await loadExcalidrawAsset({ workspaceId: state.workspaceId, fileId: metadata.fileId });
    if (!asset) throw new Error(`Excalidraw checkpoint asset is missing: ${metadata.fileId}.`);
    if (asset.data.byteLength !== metadata.sizeBytes || asset.metadata.contentHash !== metadata.contentHash
      || asset.metadata.mimeType !== metadata.mimeType) throw new Error(`Excalidraw checkpoint asset metadata changed: ${metadata.fileId}.`);
    files[metadata.fileId] = {
      id: metadata.fileId,
      mimeType: metadata.mimeType,
      dataURL: `data:${metadata.mimeType};base64,${asset.data.toString('base64')}`,
      created: metadata.createdAt,
      lastRetrieved: metadata.createdAt,
      version: metadata.version,
    };
  }
  const content = JSON.stringify(scene, null, 2);
  if (Buffer.byteLength(content, 'utf8') > MAX_PORTABLE_EXCALIDRAW_BYTES) throw new ExcalidrawCheckpointError(
    'EXCALIDRAW_CHECKPOINT_TOO_LARGE', 413, 'Portable Excalidraw checkpoint exceeds the 50 MiB limit.');
  return content;
}
export async function materializeExcalidrawCheckpoint(input: {
  state: PersistedExcalidrawScene;
  workspace: WorkspaceContext;
  actorUserId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  sourceSessionId?: string | null;
  beforePublish?: () => Promise<void>;
}): Promise<{ content: string; revisionId: string; sceneSequence: number }> {
  if (input.state.workspaceId !== input.workspace.workspaceId) throw new Error('Excalidraw checkpoint workspace mismatch.');
  if (input.state.status !== 'active') throw new Error('Archived Excalidraw scenes cannot be checkpointed.');
  const fileOptions = workspaceFileOptions(input.workspace);
  const result = await withWorkspaceMutationLock(input.workspace.workspaceId, () =>
    withExcalidrawSceneTransaction(input.state.documentId, async (transaction) => {
      const state = await loadExcalidrawSceneInTransaction(transaction, input.state.documentId, false, true);
      if (!state || state.workspaceId !== input.workspace.workspaceId || state.status !== 'active'
        || state.lifecycleGeneration !== input.state.lifecycleGeneration) {
        throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_STALE', 409, 'The Excalidraw checkpoint lifecycle is stale.');
      }
      const identity = await transaction.get(`SELECT id, snapshot_revision_id FROM collaboration_documents
        WHERE id = $1 AND workspace_id = $2 AND path = $3 AND provider = 'excalidraw' AND status = 'active'
        FOR UPDATE`, [state.documentId, state.workspaceId, state.path]) as { id: string; snapshot_revision_id: string | null } | undefined;
      if (!identity) throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_STALE', 409, 'The Excalidraw checkpoint document identity is stale.');
      await input.beforePublish?.();
      const restore = await transaction.get(`SELECT lineage_id,restored_revision_id,scene_sequence,canonical_hash,
        approved_file_hash,approved_file_dev,approved_file_ino,checkpoint_completed FROM collaboration_excalidraw_restores
        WHERE document_id=$1 AND lifecycle_generation=$2 AND
          (checkpoint_completed=false OR (scene_sequence=$3 AND canonical_hash=$4))
        ORDER BY scene_sequence DESC,created_at DESC LIMIT 1`,
      [state.documentId,state.lifecycleGeneration,state.sceneSequence,state.canonicalHash]) as {
        lineage_id: string; restored_revision_id: string; scene_sequence: number | string; canonical_hash: string;
        approved_file_hash: string | null; approved_file_dev: string | null; approved_file_ino: string | null;
        checkpoint_completed: boolean;
      } | undefined;
      const exactRestore = restore && Number(restore.scene_sequence) === state.sceneSequence && restore.canonical_hash === state.canonicalHash;
      const selected = exactRestore ? await createExcalidrawVersionContentStore(transaction).readRevisionContent({
        revisionId: restore.restored_revision_id, workspaceId: state.workspaceId, lineageId: restore.lineage_id,
      }) : null;
      if (exactRestore && !selected) throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_VERSION_MISSING', 503,
        'The selected immutable restore version is unavailable.');
      const content = selected ? selected.content.toString('utf8') : await serializePortableExcalidrawScene(state);
      if (Buffer.byteLength(content, 'utf8') > MAX_PORTABLE_EXCALIDRAW_BYTES) throw new ExcalidrawCheckpointError(
        'EXCALIDRAW_CHECKPOINT_TOO_LARGE', 413, 'Portable Excalidraw checkpoint exceeds the 50 MiB limit.');
      const hash = createHash('sha256').update(content).digest('hex');
      const stagedIdentity: { value: { dev: string; ino: string } | null } = { value: null };
      const saveStagedIntent = async (identity: { dev: string; ino: string }) => {
        // Commit proof of the fsynced staging inode before its physical publication.
        const journal = await openDb();
        try {
          await journal.run(`INSERT INTO collaboration_excalidraw_checkpoint_intents
            (document_id,lifecycle_generation,scene_sequence,content_hash,file_dev,file_ino,created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (document_id,lifecycle_generation,scene_sequence)
            DO UPDATE SET content_hash=EXCLUDED.content_hash,file_dev=EXCLUDED.file_dev,file_ino=EXCLUDED.file_ino`,
          [state.documentId,state.lifecycleGeneration,state.sceneSequence,hash,identity.dev,identity.ino,Date.now()]);
          stagedIdentity.value = identity;
        } finally { await journal.close(); }
      };
      try { await resolveExistingWorkspacePath(state.path, fileOptions); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!restore || restore.checkpoint_completed || restore.approved_file_hash !== null) {
          throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_MISSING', 409,
            'The Excalidraw checkpoint file is missing. Restore the document before retrying.');
        }
        try {
          await withExcalidrawPublication(state.workspaceId, state.path, () =>
            writeFileIfAbsent(state.path, content, fileOptions, undefined, saveStagedIntent));
        } catch (publicationError) {
          if ((publicationError as NodeJS.ErrnoException).code === 'EEXIST') throw new ExcalidrawCheckpointConflictError();
          throw publicationError;
        }
      }
      const checkpointPath = await resolveExistingWorkspacePath(state.path, fileOptions);
      const beforeIdentity = await stat(checkpointPath, { bigint: true });
      const before = await getWorkspaceFileRevision(state.path, fileOptions);
      if (!before) throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_MISSING', 409,
        'The Excalidraw checkpoint file is missing. Restore the document before retrying.');
      let previousHash = state.checkpointContentHash;
      const previousRevisionId = state.checkpointRevisionId ?? identity.snapshot_revision_id;
      if (!previousHash && previousRevisionId) {
        const previous = await transaction.get(`SELECT content_hash FROM file_revisions
          WHERE id = $1 AND workspace_id = $2`, [previousRevisionId, state.workspaceId]) as { content_hash: string } | undefined;
        previousHash = previous?.content_hash ?? null;
      }
      const original = await readFile(state.path, fileOptions);
      if (!sameCheckpointFileIdentity(beforeIdentity, await stat(checkpointPath, { bigint: true }))) {
        throw new ExcalidrawCheckpointConflictError();
      }
      const recovery = await transaction.get(`SELECT content_hash, file_dev, file_ino FROM collaboration_excalidraw_checkpoint_intents
        WHERE document_id = $1 AND lifecycle_generation = $2 AND content_hash = $3
          AND ((file_dev = $4 AND file_ino = $5) OR (file_dev IS NULL AND file_ino IS NULL))
        ORDER BY CASE WHEN file_dev = $4 AND file_ino = $5 THEN 0 ELSE 1 END LIMIT 1`,
      [state.documentId, state.lifecycleGeneration, before.sha256, String(beforeIdentity.dev), String(beforeIdentity.ino)]) as {
        content_hash: string; file_dev: string | null; file_ino: string | null;
      } | undefined;
      const pendingCreate = await transaction.get(`SELECT file_dev, file_ino FROM collaboration_excalidraw_creates
        WHERE workspace_id = $1 AND document_id = $2 AND status = 'preparing' LIMIT 1 FOR UPDATE`,
      [state.workspaceId, state.documentId]) as { file_dev: string | null; file_ino: string | null } | undefined;
      const provenRecovery = recovery?.file_dev === String(beforeIdentity.dev) && recovery.file_ino === String(beforeIdentity.ino);
      const pendingRestore = restore && !restore.checkpoint_completed;
      const recoverable = pendingCreate || pendingRestore ? provenRecovery : Boolean(recovery);
      const approvedRestoreBaseline = pendingRestore && restore.approved_file_hash === before.sha256
        && restore.approved_file_dev === String(beforeIdentity.dev) && restore.approved_file_ino === String(beforeIdentity.ino);
      if (pendingRestore && !provenRecovery && !approvedRestoreBaseline) {
        await captureExcalidrawVersion({ workspace: input.workspace,path: state.path,content: original,
          source: 'external_import',historyOnly: true,transaction });
        return { conflict: true as const };
      }
      if (pendingCreate && !provenRecovery && (pendingCreate.file_dev !== String(beforeIdentity.dev)
        || pendingCreate.file_ino !== String(beforeIdentity.ino))) {
        throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_CREATE_OWNERSHIP', 409,
          'The interrupted Excalidraw creation no longer owns its file. The replacement has been preserved.');
      }
      const initialLegacyMatch = !previousHash && state.sceneSequence === 0 && legacyPortableSceneMatches(original, state);
      if (before.sha256 !== previousHash && !recoverable && !approvedRestoreBaseline && !initialLegacyMatch) {
        await captureExcalidrawVersion({ workspace: input.workspace, path: state.path,
          content: await readFile(state.path, fileOptions), source: 'external_import', historyOnly: true, transaction });
        return { conflict: true as const };
      }
      if (before.sha256 !== hash) {
        await withExcalidrawPublication(state.workspaceId, state.path, () => writeFile(state.path, content, fileOptions, async () => {
          const observed = await getWorkspaceFileRevision(state.path, fileOptions);
          if (observed?.sha256 !== before.sha256
            || !sameCheckpointFileIdentity(beforeIdentity, await stat(checkpointPath, { bigint: true }))) {
            throw new ExcalidrawCheckpointConflictError();
          }
        }, saveStagedIntent));
      }
      const publicationIdentity = await stat(checkpointPath, { bigint: true });
      if (stagedIdentity.value && (stagedIdentity.value.dev !== String(publicationIdentity.dev)
        || stagedIdentity.value.ino !== String(publicationIdentity.ino))) throw new ExcalidrawCheckpointConflictError();
      const actual = await readFile(state.path, fileOptions);
      if (createHash('sha256').update(actual).digest('hex') !== hash
        || !sameCheckpointFileIdentity(publicationIdentity, await stat(checkpointPath, { bigint: true }))) {
        throw new ExcalidrawCheckpointConflictError();
      }
      const version = await captureExcalidrawVersion({ workspace: input.workspace, path: state.path, content: actual,
        source: exactRestore ? 'restore' : input.actorType === 'agent' ? 'agent_apply' : 'automatic_checkpoint',
        revisionId: exactRestore ? restore.restored_revision_id : undefined,
        actorUserId: input.actorUserId, actorType: input.actorType, sourceSessionId: input.sourceSessionId, transaction });
      if (!sameCheckpointFileIdentity(publicationIdentity, await stat(checkpointPath, { bigint: true }))) {
        throw new ExcalidrawCheckpointConflictError();
      }
      if (before.sha256 !== hash || provenRecovery) {
        await transaction.run(`UPDATE collaboration_excalidraw_creates SET file_dev = $1, file_ino = $2, updated_at = $3
          WHERE workspace_id = $4 AND document_id = $5 AND status = 'preparing'`,
        [String(publicationIdentity.dev), String(publicationIdentity.ino), Date.now(), state.workspaceId, state.documentId]);
      }
      await transaction.run(`UPDATE collaboration_excalidraw_states
        SET checkpoint_sequence = $1, checkpoint_revision_id = $2, checkpoint_content_hash = $3,
          checkpointed_at = $4, degraded_reason = NULL
        WHERE document_id = $5 AND lifecycle_generation = $6 AND scene_sequence = $1 AND status = 'active'`,
      [state.sceneSequence, version.revisionId, hash, Date.now(), state.documentId, state.lifecycleGeneration]);
      await transaction.run(`UPDATE collaboration_documents SET snapshot_revision_id = $1, state_version = $2, updated_at = $3
        WHERE id = $4 AND workspace_id = $5 AND path = $6 AND status = 'active' AND provider = 'excalidraw'`,
      [version.revisionId, state.sceneSequence, Date.now(), state.documentId, state.workspaceId, state.path]);
      await transaction.run('DELETE FROM collaboration_excalidraw_checkpoint_intents WHERE document_id = $1', [state.documentId]);
      await transaction.run(`UPDATE collaboration_excalidraw_restores SET checkpoint_completed=true
        WHERE document_id=$1 AND lifecycle_generation=$2 AND scene_sequence<=$3`,
      [state.documentId,state.lifecycleGeneration,state.sceneSequence]);
      return { conflict: false as const, content: actual.toString('utf8'), revisionId: version.revisionId,
        sceneSequence: state.sceneSequence, path: state.path };
    })).then(result => {
      if (result.conflict) throw new ExcalidrawCheckpointConflictError();
      return result;
    }).catch(async (error: unknown) => {
      // Headless failures must expose the same durable degraded state as editor failures.
      // Generation fencing prevents a late failed checkpoint from degrading a restored document.
      await withWorkspaceMutationLock(input.workspace.workspaceId, () =>
        withExcalidrawSceneTransaction(input.state.documentId, async (transaction) => {
          const state = await loadExcalidrawSceneInTransaction(transaction, input.state.documentId, false, true);
          if (!state || state.workspaceId !== input.workspace.workspaceId || state.lifecycleGeneration !== input.state.lifecycleGeneration) return;
          if (error instanceof ExcalidrawCheckpointConflictError) {
            const bytes = await readFile(state.path, fileOptions);
            const hash = createHash('sha256').update(bytes).digest('hex');
            const identity = await stat(await resolveExistingWorkspacePath(state.path, fileOptions), { bigint: true });
            const ownPublication = await transaction.get(`SELECT content_hash FROM collaboration_excalidraw_checkpoint_intents
              WHERE document_id = $1 AND lifecycle_generation = $2 AND content_hash = $3
                AND ((file_dev = $4 AND file_ino = $5) OR (file_dev IS NULL AND file_ino IS NULL
                  AND NOT EXISTS (SELECT 1 FROM collaboration_excalidraw_creates
                    WHERE document_id = $1 AND status = 'preparing'))) LIMIT 1`,
            [state.documentId, state.lifecycleGeneration, hash, String(identity.dev), String(identity.ino)]);
            if (hash !== state.checkpointContentHash && !ownPublication) await captureExcalidrawVersion({
              workspace: input.workspace, path: state.path, content: bytes, source: 'external_import', historyOnly: true, transaction,
            });
          }
          await transaction.run(`UPDATE collaboration_excalidraw_states SET degraded_reason = $1
            WHERE document_id = $2 AND lifecycle_generation = $3 AND status = 'active'`,
          [error instanceof Error ? error.message.slice(0, 2_000) : 'Excalidraw checkpoint failed.', state.documentId, state.lifecycleGeneration]);
        })).catch(() => { console.warn('[Excalidraw checkpoint] Could not record the degraded checkpoint state.'); });
      if (error instanceof ExcalidrawCheckpointError) throw error;
      throw new ExcalidrawCheckpointError('EXCALIDRAW_CHECKPOINT_FAILED', 503,
        error instanceof Error ? error.message : 'Excalidraw checkpoint failed.');
    });
  invalidateWorkspaceFileViews({
    fileOptions,
    subtreeDirs: [getParentDirectory(result.path)],
    mutations: [{ path: result.path, type: 'change' }],
  });
  queuePublicSharesAfterWrite([result.path], input.workspace);
  return { content: result.content, revisionId: result.revisionId, sceneSequence: result.sceneSequence };
}
