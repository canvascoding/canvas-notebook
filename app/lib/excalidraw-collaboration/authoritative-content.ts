import 'server-only';

import { createHash } from 'node:crypto';
import type { SqlConnection } from '@/app/lib/db';
import type { FileVersionCurrentFenceV1 } from '@/app/lib/file-version-center/contracts/v1';
import { serializePortableExcalidrawScene } from './checkpoint';
import type { PersistedExcalidrawScene } from './repository';
import { createExcalidrawVersionContentStore } from './version-history';

export function excalidrawVersionStateHash(state: PersistedExcalidrawScene): string {
  return createHash('sha256').update(JSON.stringify([state.documentId, state.lifecycleGeneration,
    state.sceneSequence, state.canonicalHash])).digest('hex');
}

/** Preserve selected portable bytes when they are bound to this exact durable scene. */
export async function authoritativeExcalidrawVersionContent(transaction: SqlConnection, state: PersistedExcalidrawScene,
  lineageId: string): Promise<{ content: string; fence: FileVersionCurrentFenceV1; observedAt: number }> {
  const restore = await transaction.get(`SELECT restored_revision_id FROM collaboration_excalidraw_restores
    WHERE document_id = $1 AND lifecycle_generation = $2 AND scene_sequence = $3 AND canonical_hash = $4
    ORDER BY created_at DESC LIMIT 1`, [state.documentId, state.lifecycleGeneration, state.sceneSequence, state.canonicalHash]) as {
      restored_revision_id: string;
    } | undefined;
  const revisionId = restore?.restored_revision_id
    ?? (state.checkpointSequence === state.sceneSequence ? state.checkpointRevisionId : null);
  if (revisionId) {
    const stored = await createExcalidrawVersionContentStore(transaction).readRevisionContent({
      revisionId, workspaceId: state.workspaceId, lineageId,
    });
    if (!stored || (!restore && stored.binding.sha256 !== state.checkpointContentHash)) {
      throw new Error('The authoritative Excalidraw portable revision is unavailable.');
    }
    return { content: stored.content.toString('utf8'), fence: { revisionId, sha256: stored.binding.sha256,
      stateVectorHash: excalidrawVersionStateHash(state) }, observedAt: Date.now() };
  }
  const content = await serializePortableExcalidrawScene(state);
  const hash = createHash('sha256').update(content).digest('hex');
  const latest = await transaction.get(`SELECT id FROM file_revisions WHERE lineage_id = $1 AND history_only = false
    AND content_hash = $2 ORDER BY revision_number DESC LIMIT 1`, [lineageId, hash]) as { id: string } | undefined;
  return { content, fence: { revisionId: latest?.id ?? null, sha256: hash,
    stateVectorHash: excalidrawVersionStateHash(state) }, observedAt: Date.now() };
}
