import { createHash } from 'node:crypto';

import type { WorkspaceFileLinkEditV1 } from './workspace-link-contract-v1';
import type { WorkspaceFileOperationPreview } from './workspace-file-operation-planner';

export type WorkspaceLinkWriteGroup = {
  workspaceId: string;
  path: string;
  sourceWorkspaceId: string;
  sourcePathBefore: string;
  beforeSha256: string;
  afterSha256: string;
  afterContent: string;
  edits: WorkspaceFileLinkEditV1[];
};

export class WorkspaceLinkWriteGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLinkWriteGroupError';
  }
}

/** Convert a server-rebuilt ready plan into one independently fenced write per Markdown document. */
export function groupWorkspaceLinkWrites(plan: WorkspaceFileOperationPreview): WorkspaceLinkWriteGroup[] {
  if (plan.readiness !== 'ready') throw new WorkspaceLinkWriteGroupError('Blocked link plans cannot be applied.');
  const byDestination = new Map<string, WorkspaceLinkWriteGroup>();
  for (const content of plan.previewContents) {
    const key = `${content.workspaceId}\0${content.path}`;
    if (byDestination.has(key)) throw new WorkspaceLinkWriteGroupError('Duplicate Markdown destination in link plan.');
    byDestination.set(key, {
      workspaceId: content.workspaceId,
      path: content.path,
      sourceWorkspaceId: '',
      sourcePathBefore: '',
      beforeSha256: '',
      afterSha256: createHash('sha256').update(content.content, 'utf8').digest('hex'),
      afterContent: content.content,
      edits: [],
    });
  }
  for (const edit of plan.linkEdits) {
    const group = byDestination.get(`${edit.destinationWorkspaceId}\0${edit.sourcePathAfter}`);
    if (!group) throw new WorkspaceLinkWriteGroupError('A link edit has no planned Markdown result.');
    if (group.edits.length === 0) {
      group.sourceWorkspaceId = edit.sourceWorkspaceId;
      group.sourcePathBefore = edit.sourcePathBefore;
      group.beforeSha256 = edit.expectedContentHash;
    } else if (group.sourceWorkspaceId !== edit.sourceWorkspaceId
      || group.sourcePathBefore !== edit.sourcePathBefore
      || group.beforeSha256 !== edit.expectedContentHash) {
      throw new WorkspaceLinkWriteGroupError('Unrelated Markdown sources share one destination.');
    }
    group.edits.push(edit);
  }
  for (const group of byDestination.values()) {
    if (group.edits.length === 0) throw new WorkspaceLinkWriteGroupError('A planned Markdown result has no link edits.');
    group.edits.sort((a, b) => a.targetRange.startUtf16 - b.targetRange.startUtf16);
  }
  return [...byDestination.values()].sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path));
}
