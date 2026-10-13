import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { openDb } from '@/app/lib/db';
import { readFile, resolveExistingWorkspacePath, writeFileIfAbsent } from '@/app/lib/filesystem/workspace-files';
import { getFileCollaborationState, ensureFileRevisionForCurrentContent } from '@/app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { normalizeWorkspaceRelativePath, assertWorkspacePathHasNoAliases } from '@/app/lib/workspaces/path-guard';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { createEmptyExcalidrawFileContent } from '@/app/lib/excalidraw-file';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { importPortableExcalidrawAssets, validatePortableExcalidrawAssets, assertPortableExcalidrawAssetBindings } from './assets';
import { materializeExcalidrawCheckpoint } from './checkpoint';
import { createExcalidrawAgentOperation, type ExcalidrawAgentSceneAction, type ExcalidrawAgentOperation } from './agent-operations';
import { ensureExcalidrawScene, loadExcalidrawScene, loadExcalidrawSceneInTransaction, withExcalidrawSceneTransaction,
  type PersistedExcalidrawScene } from './repository';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';
import { validateExcalidrawSceneReferences, validateExcalidrawElements, validateExcalidrawSceneAssetReferences } from './scene';
import { withExcalidrawPublication } from './publication-context';
import { captureExcalidrawVersion } from './version-history';
import { assertExcalidrawProviderAvailable } from './provider';
import { inspectExcalidrawCheckpoint } from './checkpoint-inspection';

export class ExcalidrawDocumentError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'ExcalidrawDocumentError';
  }
}

export type ExcalidrawDocumentActor = {
  userId: string;
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
  sessionId?: string | null;
};

export type ExcalidrawDocumentSnapshot = PersistedExcalidrawScene & {
  documentUrl: string;
  checkpoint: { status: 'saved' | 'pending' | 'failed'; sequence: number; revisionId: string | null; error: string | null };
};

type CreateReceipt = {
  workspace_id: string; actor_user_id: string; actor_id: string; idempotency_key: string;
  request_fingerprint: string; path: string; document_id: string | null;
  file_dev: string | null; file_ino: string | null; status: 'preparing' | 'completed' | 'failed';
};

function hash(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }

async function assertWorkspace(workspace: WorkspaceContext, write = false): Promise<void> {
  await assertExcalidrawProviderAvailable();
  if (!workspace.workspaceId || !workspace.permissions.canRead || (write && !workspace.permissions.canWrite)
    || (workspace.status !== undefined && workspace.status !== 'active')) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403, 'Current workspace access is required for this Excalidraw operation.');
  }
  if (workspace.legacy) throw new ExcalidrawDocumentError('EXCALIDRAW_PROVIDER_UNAVAILABLE', 503, 'Import this recovery workspace before using Excalidraw scene operations.');
}

function normalizedPath(input: string): string {
  const path = normalizeWorkspaceRelativePath(input);
  if (path === '.' || !path.toLowerCase().endsWith('.excalidraw') || path.split('/').pop() === '.excalidraw') {
    throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_PATH', 400, 'A named .excalidraw document path is required.');
  }
  return path;
}

export function excalidrawDocumentUrl(workspaceId: string, path: string): string {
  return `/notebook?${new URLSearchParams({ workspaceId, path })}`;
}

export function excalidrawDocumentSnapshot(state: PersistedExcalidrawScene): ExcalidrawDocumentSnapshot {
  return { ...state, documentUrl: excalidrawDocumentUrl(state.workspaceId, state.path), checkpoint: {
    status: state.degradedReason ? 'failed' : state.checkpointSequence >= state.sceneSequence && state.checkpointRevisionId ? 'saved' : 'pending',
    sequence: state.checkpointSequence, revisionId: state.checkpointRevisionId, error: state.degradedReason,
  } };
}

async function bindInitialVersion(workspace: WorkspaceContext, path: string, content: Buffer | string, actor?: ExcalidrawDocumentActor) {
  const revision = await ensureFileRevisionForCurrentContent({ workspace, path, contentHash: hash(content),
    sizeBytes: Buffer.byteLength(content), actorUserId: actor?.userId ?? null,
    actorType: actor?.actorType ?? 'system', sourceSessionId: actor?.sessionId ?? null });
  if (!revision.lineageId) throw new ExcalidrawDocumentError('EXCALIDRAW_IDENTITY_UNAVAILABLE', 503, 'The Excalidraw document lineage could not be persisted.');
  await captureExcalidrawVersion({ workspace, path, revisionId: revision.id, content, source: 'initial',
    actorUserId: actor?.userId, actorType: actor?.actorType, sourceSessionId: actor?.sessionId });
  return revision;
}

/** Shared, idempotent headless bootstrap used by the editor and every API adapter. */
export async function getExcalidrawDocument(input: {
  workspace: WorkspaceContext; path?: string; documentId?: string; actor?: ExcalidrawDocumentActor;
  beforeRead?: () => Promise<WorkspaceContext>;
}): Promise<ExcalidrawDocumentSnapshot> {
  await assertWorkspace(input.workspace);
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    const currentWorkspace = async () => {
      const current = await input.beforeRead?.() ?? input.workspace;
      await assertWorkspace(current);
      if (current.workspaceId !== input.workspace.workspaceId || current.rootPath !== input.workspace.rootPath
        || (current.organizationId ?? null) !== (input.workspace.organizationId ?? null)
        || input.workspace.actor && current.actor?.userId !== input.workspace.actor.userId) {
        throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403,
          'The authenticated workspace identity changed. Read the document again.');
      }
      return current;
    };
    let path = input.path ? normalizedPath(input.path) : null;
    if (input.documentId) {
      const database = await openDb();
      try {
        const document = await database.get(`SELECT d.path FROM collaboration_documents d
          JOIN file_collaboration_lineages l ON l.id=d.lineage_id AND l.status='active'
          WHERE d.id=$1 AND d.workspace_id=$2 AND d.provider='excalidraw' AND d.status='active'`,
        [input.documentId, input.workspace.workspaceId]) as { path: string } | undefined;
        if (!document) throw new ExcalidrawDocumentError('EXCALIDRAW_DOCUMENT_NOT_FOUND', 404, 'The Excalidraw document is not available in this workspace.');
        if (path && path !== document.path) throw new ExcalidrawDocumentError('EXCALIDRAW_DOCUMENT_MISMATCH', 409, 'The requested path no longer identifies this document.');
        path = normalizedPath(document.path);
      } finally { await database.close(); }
    }
    if (!path) throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_REQUEST', 400, 'Document ID or path is required.');
    let collaboration = await getFileCollaborationState({ workspace: input.workspace, path, ensureDocument: false });
    if (!collaboration.sceneCapable) {
      throw new ExcalidrawDocumentError('EXCALIDRAW_PROVIDER_UNAVAILABLE', 503, 'This workspace does not provide Excalidraw scene collaboration.');
    }
    let state = collaboration.document ? await loadExcalidrawScene(collaboration.document.id, true) : null;
    if (state && state.status !== 'active') {
      throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409, 'The Excalidraw scene lifecycle changed. Read the restored document again.');
    }
    await assertWorkspacePathHasNoAliases(input.workspace, path, { readOnly: true }).catch((error: NodeJS.ErrnoException) => {
      if (!state || error.code !== 'ENOENT') throw error;
    });
    if (state) {
      if (state.path !== path || state.workspaceId !== input.workspace.workspaceId
        || state.organizationId !== (input.workspace.organizationId ?? null)
        || (input.documentId && input.documentId !== state.documentId)) {
        throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409, 'The Excalidraw scene identity is stale.');
      }
      return withExcalidrawSceneTransaction(state.documentId, async transaction => {
        const current = await loadExcalidrawSceneInTransaction(transaction, state!.documentId, true, true);
        if (!current || current.path !== path) throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409,
          'The Excalidraw scene identity changed. Read the current scene again.');
        const workspace = await currentWorkspace();
        const inspection = await inspectExcalidrawCheckpoint(transaction, { workspace, state: current,
          beforeInspect: async () => { await currentWorkspace(); } });
        const snapshot = excalidrawDocumentSnapshot(inspection.state);
        if (inspection.ownPublicationPending && !inspection.state.degradedReason) snapshot.checkpoint.status = 'pending';
        return snapshot;
      });
    }
    // Bootstrap has no scene row to lock yet; the workspace fence prevents
    // competing identity/lifecycle mutations before this fresh admission check.
    await currentWorkspace();
    const fullPath = await resolveExistingWorkspacePath(path, { workspace: input.workspace });
    const file = await fs.stat(fullPath);
    if (!file.isFile()) throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_PATH', 400, 'The selected path is not a file.');
    let initialContent: Buffer | null = null;
    if (!state) {
      if (file.size > EXCALIDRAW_PORTABLE_MAX_BYTES) {
        throw new ExcalidrawDocumentError('EXCALIDRAW_SCENE_TOO_LARGE', 413, 'Portable Excalidraw files must not exceed 50 MiB.');
      }
      initialContent = await readFile(path, { workspace: input.workspace });
      if (initialContent.byteLength > EXCALIDRAW_PORTABLE_MAX_BYTES) {
        throw new ExcalidrawDocumentError('EXCALIDRAW_SCENE_TOO_LARGE', 413, 'Portable Excalidraw files must not exceed 50 MiB.');
      }
      let root: Record<string, unknown>;
      try { root = JSON.parse(initialContent.toString('utf8')); }
      catch { throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_SCENE', 422, 'The existing Excalidraw document is not valid JSON.'); }
      if (!root || Array.isArray(root) || root.type !== 'excalidraw' || !Array.isArray(root.elements)) {
        throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_SCENE', 422, 'The existing file has an invalid Excalidraw scene.');
      }
      const elements = validateExcalidrawElements(root.elements, 'scene');
      validateExcalidrawSceneReferences(elements);
      const assets = validatePortableExcalidrawAssets(initialContent.toString('utf8'));
      validateExcalidrawSceneAssetReferences(elements, assets);
      await assertPortableExcalidrawAssetBindings(input.workspace.workspaceId, assets);
    }
    await currentWorkspace();
    if (!collaboration.document) collaboration = await getFileCollaborationState({ workspace: input.workspace, path, ensureDocument: true });
    if (collaboration.document?.provider !== 'excalidraw') {
      throw new ExcalidrawDocumentError('EXCALIDRAW_PROVIDER_UNAVAILABLE', 503, 'The Excalidraw identity could not be initialized.');
    }
    if (input.documentId && input.documentId !== collaboration.document.id) {
      throw new ExcalidrawDocumentError('EXCALIDRAW_DOCUMENT_MISMATCH', 409, 'The document lifecycle changed. Read the scene again.');
    }
    // Bind any interrupted creator before admitting a scene. The staged inode
    // receipt proves ownership even if another reader finishes initialization.
    const identity = await fs.stat(fullPath, { bigint: true });
    const receiptDatabase = await openDb();
    let pendingCreate: { document_id: string | null; file_dev: string | null; file_ino: string | null } | undefined;
    try {
      await receiptDatabase.run(`UPDATE collaboration_excalidraw_creates SET document_id=$1,updated_at=$2
        WHERE workspace_id=$3 AND path=$4 AND status='preparing' AND document_id IS NULL
          AND file_dev=$5 AND file_ino=$6`,
      [collaboration.document.id, Date.now(), input.workspace.workspaceId, path, String(identity.dev), String(identity.ino)]);
      pendingCreate = await receiptDatabase.get(`SELECT document_id,file_dev,file_ino FROM collaboration_excalidraw_creates
        WHERE workspace_id=$1 AND path=$2 AND status='preparing' AND document_id=$3 LIMIT 1`,
      [input.workspace.workspaceId, path, collaboration.document.id]) as typeof pendingCreate;
    } finally { await receiptDatabase.close(); }
    if (pendingCreate && (pendingCreate.file_dev !== String(identity.dev) || pendingCreate.file_ino !== String(identity.ino))) {
      throw new ExcalidrawDocumentError('PATH_EXISTS', 409, 'The interrupted creation no longer owns this file. Its replacement has been preserved.');
    }
    if (!state) {
      const content = initialContent!;
      if (pendingCreate && hash(content) !== hash(createEmptyExcalidrawFileContent())) {
        throw new ExcalidrawDocumentError('EXCALIDRAW_EXTERNAL_CHANGE', 409, 'The newly created file changed before its scene was initialized. Its bytes have been preserved.');
      }
      await currentWorkspace();
      const revision = await bindInitialVersion(input.workspace, path, content, input.actor);
      const assets = await importPortableExcalidrawAssets({ workspaceId: input.workspace.workspaceId, content: content.toString('utf8') });
      state = await ensureExcalidrawScene({ documentId: collaboration.document.id, workspaceId: input.workspace.workspaceId,
        organizationId: input.workspace.organizationId ?? null, path, initialContent: content.toString('utf8'), initialAssets: assets });
      const checkpointDatabase = await openDb();
      try {
        await checkpointDatabase.run(`UPDATE collaboration_excalidraw_states SET checkpoint_revision_id=$1
          WHERE document_id=$2 AND scene_sequence=0 AND checkpoint_revision_id IS NULL AND status='active'`,
        [revision.id, state.documentId]);
      } finally { await checkpointDatabase.close(); }
      state = await loadExcalidrawScene(state.documentId) ?? state;
    }
    if (state.path !== path || state.workspaceId !== input.workspace.workspaceId || state.status !== 'active'
      || state.organizationId !== (input.workspace.organizationId ?? null)) {
      throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409, 'The Excalidraw scene identity is stale.');
    }
    return excalidrawDocumentSnapshot(state);
  });
}

async function completeCreate(workspace: WorkspaceContext, receipt: CreateReceipt, actor: ExcalidrawDocumentActor) {
  const document = await getExcalidrawDocument({ workspace,
    ...(receipt.document_id ? { documentId: receipt.document_id } : { path: receipt.path }), actor });
  const database = await openDb();
  try {
    await database.run(`UPDATE collaboration_excalidraw_creates SET status='completed',document_id=$1,updated_at=$2
      WHERE workspace_id=$3 AND actor_user_id=$4 AND actor_id=$5 AND idempotency_key=$6`,
    [document.documentId, Date.now(), workspace.workspaceId, actor.userId, actor.actorId, receipt.idempotency_key]);
  } finally { await database.close(); }
  invalidateWorkspaceFileViews({ fileOptions: { workspace }, fullTree: true, mutations: [{ path: document.path, type: 'add' }] });
  return document;
}

export async function createExcalidrawDocument(input: {
  workspace: WorkspaceContext; path: string; actor: ExcalidrawDocumentActor; idempotencyKey: string;
  beforeApply?: () => Promise<void>;
}): Promise<ExcalidrawDocumentSnapshot> {
  await assertWorkspace(input.workspace, true);
  const path = normalizedPath(input.path);
  if (!input.actor.userId || !input.actor.actorId || !input.idempotencyKey || input.idempotencyKey.length > 500) {
    throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_REQUEST', 400, 'A trusted actor and an idempotency key of at most 500 characters are required.');
  }
  const fingerprint = hash(JSON.stringify({ workspaceId: input.workspace.workspaceId, path }));
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    await input.beforeApply?.();
    const database = await openDb();
    let receipt: CreateReceipt;
    const scope = [input.workspace.workspaceId, input.actor.userId, input.actor.actorId, input.idempotencyKey];
    try {
      await database.run(`INSERT INTO collaboration_excalidraw_creates
        (workspace_id,actor_user_id,actor_id,idempotency_key,request_fingerprint,path,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING`, [...scope, fingerprint, path, Date.now()]);
      receipt = await database.get(`SELECT * FROM collaboration_excalidraw_creates
        WHERE workspace_id=$1 AND actor_user_id=$2 AND actor_id=$3 AND idempotency_key=$4`, scope) as CreateReceipt;
      if (receipt.request_fingerprint !== fingerprint) throw new ExcalidrawDocumentError('EXCALIDRAW_IDEMPOTENCY_CONFLICT', 409, 'This idempotency key belongs to a different create request.');
      if (receipt.status === 'completed') return getExcalidrawDocument({ workspace: input.workspace, documentId: receipt.document_id!, actor: input.actor });
      if (receipt.document_id) return completeCreate(input.workspace, receipt, input.actor);
      const currentPath = normalizedPath(receipt.path);
      await assertWorkspacePathHasNoAliases(input.workspace, currentPath);
      if (!receipt.file_dev || !receipt.file_ino) {
        const managed = await database.get(`SELECT d.id FROM collaboration_documents d
          JOIN file_collaboration_lineages l ON l.id=d.lineage_id AND l.status='active'
          WHERE d.workspace_id=$1 AND d.path=$2 AND d.provider='excalidraw' AND d.status='active'`,
        [input.workspace.workspaceId, currentPath]);
        if (managed) throw new ExcalidrawDocumentError('PATH_EXISTS', 409,
          'This path already belongs to an active Excalidraw document. Restore its checkpoint or delete the document before reusing the path.');
      }
      const existing = await resolveExistingWorkspacePath(currentPath, { workspace: input.workspace }).then(p => fs.stat(p, { bigint: true }))
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) {
        if (!receipt.file_dev || !receipt.file_ino || String(existing.dev) !== receipt.file_dev || String(existing.ino) !== receipt.file_ino) {
          throw new ExcalidrawDocumentError('PATH_EXISTS', 409, 'A file or folder already exists at this path.');
        }
      } else {
        if (currentPath !== path) throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409,
          'The interrupted creation was moved and its published file is no longer available. Restore that file before retrying.');
        await withExcalidrawPublication(input.workspace.workspaceId, currentPath, () => writeFileIfAbsent(currentPath,
          createEmptyExcalidrawFileContent(), { workspace: input.workspace }, input.beforeApply,
          async identity => {
            await database.run(`UPDATE collaboration_excalidraw_creates SET file_dev=$1,file_ino=$2,status='preparing',updated_at=$3
              WHERE workspace_id=$4 AND actor_user_id=$5 AND actor_id=$6 AND idempotency_key=$7`,
            [identity.dev, identity.ino, Date.now(), ...scope]);
          }));
      }
    } finally { await database.close(); }
    const document = await completeCreate(input.workspace, receipt!, input.actor);
    await recordAuditEvent({ organizationId: input.workspace.organizationId, workspaceId: input.workspace.workspaceId,
      userId: input.actor.userId, source: 'files', eventType: 'file', entityType: 'workspace_path', entityId: path,
      action: 'excalidraw.create', status: 'success', summary: `Excalidraw document created at ${path}.`, metadata: { documentId: document.documentId } });
    return document;
  });
}

export async function applyExcalidrawChanges(input: {
  workspace: WorkspaceContext; actor: ExcalidrawDocumentActor; documentId: string; path?: string;
  lifecycleGeneration: number; observedSceneSequence: number; actions: ExcalidrawAgentSceneAction[];
  idempotencyKey: string; beforeApply?: () => Promise<void>;
}): Promise<ExcalidrawAgentOperation & { sceneSequence: number; checkpoint: ExcalidrawDocumentSnapshot['checkpoint']; documentUrl: string }> {
  await assertWorkspace(input.workspace, true);
  if (!input.documentId || !input.actor.userId || !input.actor.actorId || !input.idempotencyKey || input.idempotencyKey.length > 500
    || !Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 1
    || !Number.isSafeInteger(input.observedSceneSequence) || input.observedSceneSequence < 0) {
    throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_REQUEST', 400, 'Document identity, trusted actor, idempotency key, current lifecycle generation and observed scene sequence are required.');
  }
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    await input.beforeApply?.();
    const scene = await getExcalidrawDocument(input);
    if (scene.lifecycleGeneration !== input.lifecycleGeneration) throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409, 'The document lifecycle changed. Read the scene again.');
    const operation = await createExcalidrawAgentOperation({ workspace: input.workspace, documentId: scene.documentId,
      lifecycleGeneration: input.lifecycleGeneration, observedSceneSequence: input.observedSceneSequence,
      actions: input.actions, idempotencyKey: input.idempotencyKey,
      initiatedByUserId: input.actor.userId, actorId: input.actor.actorId, beforeApply: input.beforeApply });
    if (operation.status === 'applied') {
      const current = await loadExcalidrawScene(scene.documentId);
      if (current) await materializeExcalidrawCheckpoint({ state: current, workspace: input.workspace,
        actorUserId: input.actor.userId, actorType: input.actor.actorType, sourceSessionId: input.actor.sessionId })
        .catch(() => undefined); // The persisted operation stays applied; checkpoint failure is returned separately.
    }
    const after = await getExcalidrawDocument({ workspace: input.workspace, documentId: scene.documentId });
    return { ...operation, sceneSequence: after.sceneSequence, checkpoint: after.checkpoint, documentUrl: after.documentUrl };
  });
}

/** Resume metadata only for a published inode owned by a durable create receipt. */
export async function recoverPendingExcalidrawCreates(limit = 50): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Invalid Excalidraw create recovery batch limit.');
  const database = await openDb();
  let receipts: CreateReceipt[];
  try { receipts = await database.all(`SELECT * FROM collaboration_excalidraw_creates
    WHERE status='preparing' AND file_dev IS NOT NULL AND file_ino IS NOT NULL
    ORDER BY updated_at,created_at,workspace_id,actor_user_id,actor_id,idempotency_key LIMIT $1`, [limit]) as CreateReceipt[]; }
  finally { await database.close(); }
  const { resolveExcalidrawCheckpointWorkspace } = await import('./checkpoint-worker');
  for (const selectedReceipt of receipts) {
    let receipt = selectedReceipt;
    const workspace = await resolveExcalidrawCheckpointWorkspace(receipt.workspace_id);
    if (workspace) await withWorkspaceMutationLock(workspace.workspaceId, async () => {
      // A rename can commit between the batch read and acquisition of the
      // workspace fence. Recover from the current durable locator only.
      const receiptDatabase = await openDb();
      try {
        const currentReceipt = await receiptDatabase.get(`SELECT * FROM collaboration_excalidraw_creates
          WHERE workspace_id=$1 AND actor_user_id=$2 AND actor_id=$3 AND idempotency_key=$4 AND status='preparing'`,
        [receipt.workspace_id, receipt.actor_user_id, receipt.actor_id, receipt.idempotency_key]) as CreateReceipt | undefined;
        if (!currentReceipt || !currentReceipt.file_dev || !currentReceipt.file_ino) return;
        receipt = currentReceipt;
      } finally { await receiptDatabase.close(); }
      let currentPath = receipt.path;
      if (receipt.document_id) {
        const identityDatabase = await openDb();
        try {
          const document = await identityDatabase.get(`SELECT document.path FROM collaboration_documents document
            JOIN file_collaboration_lineages lineage ON lineage.id=document.lineage_id AND lineage.status='active'
            WHERE document.id=$1 AND document.workspace_id=$2 AND document.provider='excalidraw' AND document.status='active'`,
          [receipt.document_id, workspace.workspaceId]) as { path: string } | undefined;
          if (!document) return;
          currentPath = normalizedPath(document.path);
        } finally { await identityDatabase.close(); }
      }
      const fullPath = await resolveExistingWorkspacePath(currentPath, { workspace }).catch(() => null);
      if (!fullPath) return;
      const identity = await fs.stat(fullPath, { bigint: true });
      if (String(identity.dev) !== receipt.file_dev || String(identity.ino) !== receipt.file_ino) return;
      await completeCreate(workspace, receipt, { userId: receipt.actor_user_id, actorId: receipt.actor_id, actorType: 'system' });
    }).catch(error => console.warn('[Excalidraw] Create recovery deferred.', error instanceof Error ? error.name : 'unknown'));
    // Rotate deferred receipts durably so broken or unavailable targets cannot
    // starve later owned creations, including across application restarts.
    const journal = await openDb();
    try {
      await journal.run(`UPDATE collaboration_excalidraw_creates SET updated_at=$1
        WHERE workspace_id=$2 AND actor_user_id=$3 AND actor_id=$4 AND idempotency_key=$5 AND status='preparing'`,
      [Date.now(), receipt.workspace_id, receipt.actor_user_id, receipt.actor_id, receipt.idempotency_key]);
    } finally { await journal.close(); }
  }
}
