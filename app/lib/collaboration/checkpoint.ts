import 'server-only';

import { writeFile } from '@/app/lib/filesystem/workspace-files';
import {
  ensureFileRevisionForCurrentContent,
} from '@/app/lib/files/collaboration-policy';
import { getWorkspaceFileRevision } from '@/app/lib/files/revision-guard';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  markCollaborationCheckpoint,
  serializeCanonicalText,
  type PersistedCollaborationState,
} from './persistence';

export async function materializeCollaborationCheckpoint(input: {
  state: PersistedCollaborationState;
  workspace: WorkspaceContext;
  canonicalContent: string;
  actorUserId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  sourceSessionId?: string | null;
}): Promise<{ content: string; revisionId: string }> {
  if (input.state.workspaceId !== input.workspace.workspaceId) {
    throw new Error('Collaboration checkpoint workspace mismatch.');
  }
  if (Buffer.byteLength(input.canonicalContent, 'utf8') > 5 * 1024 * 1024) {
    throw new Error('Collaboration checkpoint exceeds the 5 MiB text limit.');
  }

  const canonical = input.canonicalContent.replace(/\r\n?/gu, '\n');
  const serialized = serializeCanonicalText(canonical, input.state);
  const fileOptions = workspaceFileOptions(input.workspace);
  await writeFile(input.state.path, serialized, fileOptions);
  const fileRevision = await getWorkspaceFileRevision(input.state.path, fileOptions);
  if (!fileRevision) throw new Error('Collaboration checkpoint could not be read after write.');

  const revision = ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.state.path,
    contentHash: fileRevision.sha256,
    sizeBytes: fileRevision.stats.size,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? 'system',
    sourceSessionId: input.sourceSessionId ?? null,
  });
  await markCollaborationCheckpoint({
    documentId: input.state.documentId,
    sequence: input.state.documentSequence,
    canonicalContent: canonical,
    serializedContent: serialized,
  });

  invalidateWorkspaceFileViews({
    fileOptions,
    subtreeDirs: [getParentDirectory(input.state.path)],
    mutations: [{ path: input.state.path, type: 'change' }],
  });
  queuePublicSharesAfterWrite([input.state.path], input.workspace);
  return { content: serialized, revisionId: revision.id };
}
