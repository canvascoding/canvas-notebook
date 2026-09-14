import 'server-only';

import { createHash } from 'node:crypto';

import { authoritativeCollaborationSnapshot } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { readFile } from '@/app/lib/filesystem/workspace-files';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  type FileVersionCurrentFenceV1,
} from './contracts/v1';
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
): Promise<AuthoritativeFileVersionContent> {
  if (target.documentId) {
    const state = await loadCollaborationState(target.documentId);
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
  const raw = await readFile(target.path, workspaceFileOptions(workspace));
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
