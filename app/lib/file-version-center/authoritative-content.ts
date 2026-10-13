import 'server-only';

import { createHash } from 'node:crypto';

import { authoritativeCollaborationSnapshot } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { readFile } from '@/app/lib/filesystem/workspace-files';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { authoritativeExcalidrawVersionContent } from '@/app/lib/excalidraw-collaboration/authoritative-content';
import { loadExcalidrawSceneInTransaction, withExcalidrawSceneTransaction } from '@/app/lib/excalidraw-collaboration/repository';
import { assertExcalidrawProviderAvailable } from '@/app/lib/excalidraw-collaboration/provider';

import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  type FileVersionCurrentFenceV1,
} from './contracts/v1';
import { createRuntimeFileVersionCenterDatabase, type FileVersionCenterDatabase } from './database';
import type { ResolvedFileVersionTarget } from './query-service';

export type AuthoritativeFileVersionContent = {
  content: string;
  fence: FileVersionCurrentFenceV1;
  observedAt: number;
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function loadAuthoritativeFileVersionContent(
  target: ResolvedFileVersionTarget,
  workspace: WorkspaceContext,
  options: {
    database?: FileVersionCenterDatabase;
    loadState?: typeof loadCollaborationState;
    readWorkspaceFile?: (path: string, workspace: WorkspaceContext) => Promise<Buffer>;
  } = {},
): Promise<AuthoritativeFileVersionContent> {
  if (workspace.workspaceId !== target.workspaceId) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
      'The authoritative document is outside the active workspace.');
  }
  if (target.path.toLowerCase().endsWith('.excalidraw')) {
    try { await assertExcalidrawProviderAvailable(); }
    catch { throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
      'PostgreSQL is required for Excalidraw version history.'); }
    if (!target.documentId) throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
      'The authoritative Excalidraw document is unavailable.');
    return withExcalidrawSceneTransaction(target.documentId, async transaction => {
      const state = await loadExcalidrawSceneInTransaction(transaction, target.documentId!, false, true);
      const identity = await transaction.get(`SELECT id FROM collaboration_documents
        WHERE id=$1 AND workspace_id=$2 AND lineage_id=$3 AND path=$4 AND provider='excalidraw' AND status='active'`,
      [target.documentId, target.workspaceId, target.lineageId, target.path]);
      if (!state || !identity || state.workspaceId !== workspace.workspaceId || state.path !== target.path) {
        throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
          'The authoritative Excalidraw document is unavailable.');
      }
      return authoritativeExcalidrawVersionContent(transaction, state, target.lineageId);
    });
  }
  const loadState = options.loadState ?? loadCollaborationState;
  const readWorkspaceFile = options.readWorkspaceFile
    ?? ((path: string, context: WorkspaceContext) => readFile(path, workspaceFileOptions(context)));
  if (target.documentId) {
    let state = await loadState(target.documentId);

    // A document with no Yjs row may use filesystem bytes only when its
    // durable lifecycle marker proves that no authoritative state ever existed.
    // Hold the document row while reading: first initialization updates this
    // marker in the same transaction as the Yjs insert and must wait for us.
    if (!state) {
      const fallback = await (options.database ?? createRuntimeFileVersionCenterDatabase()).transaction(async (transaction) => {
        const document = (await transaction.query<{
          yjs_state_lifecycle: string;
        }>(`SELECT yjs_state_lifecycle FROM collaboration_documents
            WHERE id = $1 AND workspace_id = $2 AND path = $3 AND status = 'active' AND provider = 'yjs'
            FOR SHARE`, [target.documentId, target.workspaceId, target.path])).rows[0];
        const persisted = (await transaction.query<{ document_id: string }>(
          'SELECT document_id FROM collaboration_yjs_states WHERE document_id = $1',
          [target.documentId],
        )).rows[0];
        if (!document) {
          throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
            'The authoritative collaboration state is unavailable.');
        }
        if (persisted) return null; // First initialization raced the initial state lookup.
        if (document.yjs_state_lifecycle !== 'never_initialized') {
          throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
            'The authoritative collaboration state is unavailable.');
        }
        const raw = await readWorkspaceFile(target.path, workspace);
        const contentSha256 = sha256(raw);
        return {
          content: raw.toString('utf8'),
          fence: {
            revisionId: target.latestRevisionHash === contentSha256 ? target.latestRevisionId : null,
            sha256: contentSha256,
          },
          observedAt: Date.now(),
        };
      });
      if (fallback) return fallback;
      state = await loadState(target.documentId);
    }
    if (!state || state.degraded || state.status !== 'active' || state.workspaceId !== target.workspaceId
      || state.path !== target.path) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable,
        'The authoritative collaboration state is unavailable.');
    }
    const snapshot = authoritativeCollaborationSnapshot(state);
    const content = snapshot.canonicalContent.replace(/\r\n?/gu, '\n');
    const contentSha256 = sha256(content);
    return {
      content,
      fence: {
        revisionId: target.latestRevisionHash === contentSha256 ? target.latestRevisionId : null,
        sha256: contentSha256,
        stateVectorHash: sha256(state.stateVector),
      },
      observedAt: Date.now(),
    };
  }
  const raw = await readWorkspaceFile(target.path, workspace);
  const contentSha256 = sha256(raw);
  return {
    content: raw.toString('utf8'),
    fence: {
      revisionId: target.latestRevisionHash === contentSha256 ? target.latestRevisionId : null,
      sha256: contentSha256,
    },
    observedAt: Date.now(),
  };
}

export function fileVersionFencesMatch(
  actual: FileVersionCurrentFenceV1,
  expected: FileVersionCurrentFenceV1,
): boolean {
  return actual.sha256 === expected.sha256
    && actual.revisionId === expected.revisionId
    && actual.stateVectorHash === expected.stateVectorHash;
}
