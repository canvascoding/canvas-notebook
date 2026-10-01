import 'server-only';

import { createHash } from 'node:crypto';

import { writeWorkspaceFileContent } from '@/app/lib/files/write-service';
import { readFile, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import type { WorkspaceFileLinkEditV1 } from './workspace-link-contract-v1';

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class WorkspaceLinkFileWriteError extends Error {
  readonly status = 409;

  constructor(readonly code: 'LINK_WRITE_STALE' | 'LINK_WRITE_INVALID_PLAN', message: string) {
    super(message);
    this.name = 'WorkspaceLinkFileWriteError';
  }
}

export type WorkspacePlainLinkWriteReceipt = {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  status: 'applied' | 'already-applied';
};

/** One document-sized, replay-safe write. The caller owns path/operation locks and the durable journal. */
export async function applyWorkspacePlainLinkWrite(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string;
  path: string;
  edits: readonly WorkspaceFileLinkEditV1[];
  afterContent: string;
}): Promise<WorkspacePlainLinkWriteReceipt> {
  const { edits, path } = input;
  const expectedBeforeSha256 = edits[0]?.expectedContentHash;
  if (!expectedBeforeSha256 || edits.length === 0 || edits.some((edit) => (
    edit.destinationWorkspaceId !== input.workspace.workspaceId
      || edit.sourcePathAfter !== path
      || edit.expectedContentHash !== expectedBeforeSha256
  ))) {
    throw new WorkspaceLinkFileWriteError('LINK_WRITE_INVALID_PLAN', 'Link edits do not belong to one destination document.');
  }

  const afterSha256 = sha256(input.afterContent);
  const bytes = await readFile(path, input.fileOptions);
  const beforeSha256 = sha256(bytes);
  if (beforeSha256 === afterSha256 && bytes.equals(Buffer.from(input.afterContent, 'utf8'))) {
    return { path, beforeSha256: expectedBeforeSha256, afterSha256, status: 'already-applied' };
  }
  if (beforeSha256 !== expectedBeforeSha256) {
    throw new WorkspaceLinkFileWriteError('LINK_WRITE_STALE', 'Markdown content changed since the link plan was prepared.');
  }
  const content = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(content, 'utf8'))) {
    throw new WorkspaceLinkFileWriteError('LINK_WRITE_INVALID_PLAN', 'Markdown content is not lossless UTF-8.');
  }
  let rewritten = content;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of [...edits].sort((left, right) => right.targetRange.startUtf16 - left.targetRange.startUtf16)) {
    const { startUtf16, endUtf16, startUtf8Byte, endUtf8Byte } = edit.targetRange;
    if (!Number.isSafeInteger(startUtf16) || !Number.isSafeInteger(endUtf16)
      || startUtf16 < 0 || endUtf16 > content.length || endUtf16 < startUtf16
      || endUtf16 > previousStart || startUtf8Byte !== Buffer.byteLength(content.slice(0, startUtf16), 'utf8')
      || endUtf8Byte !== Buffer.byteLength(content.slice(0, endUtf16), 'utf8')
      || typeof edit.previousTargetLiteral !== 'string' || typeof edit.nextTargetLiteral !== 'string'
      || (edit.previousTargetLiteral.length === 0 && edit.nextTargetLiteral.length === 0)
      || content.slice(startUtf16, endUtf16) !== edit.previousTargetLiteral) {
      throw new WorkspaceLinkFileWriteError('LINK_WRITE_INVALID_PLAN', 'A planned Markdown link span no longer matches its source.');
    }
    rewritten = `${rewritten.slice(0, startUtf16)}${edit.nextTargetLiteral}${rewritten.slice(endUtf16)}`;
    previousStart = startUtf16;
  }
  if (rewritten !== input.afterContent) {
    throw new WorkspaceLinkFileWriteError('LINK_WRITE_INVALID_PLAN', 'The planned Markdown result differs from its link edits.');
  }

  const written = await writeWorkspaceFileContent({
    workspace: input.workspace,
    fileOptions: input.fileOptions,
    actorUserId: input.actorUserId,
    path,
    content: input.afterContent,
    expectedSha256: expectedBeforeSha256,
    requireExpectedRevision: true,
    ensureCollaborationDocument: false,
  });
  if (written.stats.sha256 !== afterSha256) {
    throw new WorkspaceLinkFileWriteError('LINK_WRITE_STALE', 'Published Markdown content differs from the planned result.');
  }
  return { path, beforeSha256, afterSha256, status: 'applied' };
}
