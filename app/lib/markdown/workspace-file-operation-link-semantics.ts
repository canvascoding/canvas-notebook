import path from 'node:path';
import type { WorkspaceLinkEdge } from './workspace-link-index-core';
import { parseWorkspaceMarkdownHref } from './workspace-local-link-parser';
import type { WorkspaceFileOperationPlanRequest } from './workspace-file-operation-planner';

/** A concrete path, as distinct from a Wiki basename/title/alias lookup. */
export function getWorkspaceLinkLogicalTarget(edge: WorkspaceLinkEdge): string | null {
  if (edge.kind === 'markdown') {
    const parsed = parseWorkspaceMarkdownHref(edge.targetLiteral);
    if (!parsed) return null;
    return path.posix.normalize(parsed.path.startsWith('/') ? parsed.path.slice(1)
      : path.posix.join(path.posix.dirname(edge.sourcePath), parsed.path));
  }
  const target = edge.targetText.split('#')[0].replace(/\\/gu, '/');
  // A name, even one ending in .md, can be an Obsidian basename/alias lookup.
  // Never turn that lookup into a guessed document identity.
  if (!target.includes('/')) return null;
  return path.posix.normalize(target.startsWith('./') || target.startsWith('../')
    ? path.posix.join(path.posix.dirname(edge.sourcePath), target) : target.replace(/^\/+/, ''));
}

/** Absent descendants still have an exact intended path under a selected directory. */
export function mapWorkspaceLinkLogicalTarget(target: string, request: WorkspaceFileOperationPlanRequest): string {
  const entries = request.snapshots.find((snapshot) => snapshot.workspaceId === request.sourceWorkspaceId)?.entries ?? [];
  const selection = request.selections.find((item) => target === item.sourcePath
    || (target.startsWith(`${item.sourcePath}/`) && entries.some((entry) => entry.path === item.sourcePath && entry.kind === 'directory')));
  return selection ? `${selection.destinationPath}${target.slice(selection.sourcePath.length)}` : target;
}

export function workspaceLinkLogicalTargetMatchesPath(edge: WorkspaceLinkEdge, logicalTarget: string, targetPath: string): boolean {
  return logicalTarget === targetPath || (edge.kind === 'wiki' && !/\.[^/]+$/u.test(logicalTarget)
    && (targetPath === `${logicalTarget}.md` || targetPath === `${logicalTarget}.markdown`));
}
