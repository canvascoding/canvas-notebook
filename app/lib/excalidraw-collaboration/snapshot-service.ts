import 'server-only';

import { randomUUID } from 'node:crypto';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { assertPortableExcalidrawAssetBindings, importPortableExcalidrawAssets } from './assets';
import { validatePortableExcalidrawScene } from './portable-import';
import { getExcalidrawDocument, ExcalidrawDocumentError, type ExcalidrawDocumentActor } from './scene-service';
import { applyExcalidrawScenePatchInTransaction, loadExcalidrawSceneInTransaction,
  withExcalidrawSceneTransaction } from './repository';
import { materializeExcalidrawCheckpoint } from './checkpoint';
import { canonicalSceneHash } from './scene';
import { EXCALIDRAW_MAX_PATCH_ELEMENTS, type ExcalidrawElementRecord } from './protocol';

/** A snapshot becomes versioned element changes after an exact locked read. */
export async function applyExcalidrawSnapshot(input: {
  workspace: WorkspaceContext; actor: ExcalidrawDocumentActor; documentId: string; path?: string;
  lifecycleGeneration: number; observedSceneSequence: number; content: string;
  beforeApply?: () => Promise<void>;
}) {
  if (!input.workspace.permissions.canWrite) throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403,
    'Current workspace write permission is required.');
  const parsed = validatePortableExcalidrawScene(input.content);
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    await input.beforeApply?.();
    const observed = await getExcalidrawDocument(input);
    if (observed.lifecycleGeneration !== input.lifecycleGeneration) throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409,
      'The document lifecycle changed. Read this drawing again.');
    const applied = await withExcalidrawSceneTransaction(input.documentId, async transaction => {
      const current = await loadExcalidrawSceneInTransaction(transaction, input.documentId, false, true);
      if (!current || current.workspaceId !== input.workspace.workspaceId || current.path !== observed.path
        || current.lifecycleGeneration !== input.lifecycleGeneration) {
        throw new ExcalidrawDocumentError('EXCALIDRAW_LIFECYCLE_STALE', 409, 'The document identity or lifecycle changed.');
      }
      if (current.sceneSequence !== input.observedSceneSequence) throw Object.assign(
        new ExcalidrawDocumentError('EXCALIDRAW_SCENE_CONFLICT', 409, 'This drawing changed after it was loaded.'),
        { currentSceneSequence: current.sceneSequence });
      const previous = new Map(current.elements.map(element => [element.id, element]));
      const incomingIds = new Set(parsed.elements.map(element => element.id));
      const patch: ExcalidrawElementRecord[] = [];
      const revised = (element: ExcalidrawElementRecord, old: ExcalidrawElementRecord) => {
        if (old.version >= Number.MAX_SAFE_INTEGER) throw new ExcalidrawDocumentError('EXCALIDRAW_ELEMENT_VERSION_EXHAUSTED', 409,
          'This element cannot be revised safely. Read the document and create a replacement element.');
        return { ...element, version: Math.max(old.version + 1, element.version) };
      };
      for (const element of parsed.elements) {
        const old = previous.get(element.id);
        if (!old) patch.push(element);
        else if (canonicalSceneHash({ elements: [element], appState: {} }) !== canonicalSceneHash({ elements: [old], appState: {} })) {
          patch.push(revised(element, old));
        }
      }
      for (const element of current.elements) {
        if (!element.isDeleted && !incomingIds.has(element.id)) patch.push(revised({ ...element, isDeleted: true }, element));
      }
      if (patch.length > EXCALIDRAW_MAX_PATCH_ELEMENTS) throw new ExcalidrawDocumentError('EXCALIDRAW_PATCH_TOO_LARGE', 413,
        `A snapshot may change at most ${EXCALIDRAW_MAX_PATCH_ELEMENTS} elements in one save.`);
      await input.beforeApply?.();
      await assertPortableExcalidrawAssetBindings(input.workspace.workspaceId, parsed.assets);
      const assets = await importPortableExcalidrawAssets({ workspaceId: input.workspace.workspaceId, content: input.content });
      await input.beforeApply?.();
      return applyExcalidrawScenePatchInTransaction(transaction, {
        documentId: input.documentId, lifecycleGeneration: input.lifecycleGeneration,
        baseSequence: input.observedSceneSequence, messageId: `snapshot:${randomUUID()}`,
        elements: patch, appState: parsed.appState, assets,
        actorType: input.actor.actorType, actorId: input.actor.actorId, initiatedByUserId: input.actor.userId,
      });
    });
    await materializeExcalidrawCheckpoint({ state: applied.state, workspace: input.workspace,
      actorType: input.actor.actorType, actorUserId: input.actor.userId, sourceSessionId: input.actor.sessionId }).catch(() => undefined);
    return getExcalidrawDocument({ workspace: input.workspace, documentId: input.documentId });
  });
}
