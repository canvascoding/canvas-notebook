import path from 'node:path';

import { resolveExactWorkspaceLink, type WorkspaceLinkUnevaluated } from './workspace-local-link-parser';

export type WorkspaceHtmlLinkOperationScope = {
  beforePaths: ReadonlySet<string>;
  afterPaths: ReadonlySet<string>;
  /** Includes copied/relocated sources and destinations in this workspace. */
  sourceScopes: readonly string[];
  /** Includes removed/relocated targets and newly populated destinations. */
  targetScopes: readonly string[];
};

const within = (candidate: string, scope: string): boolean => candidate === scope || candidate.startsWith(`${scope}/`);

/** Proves only that a fully inspected HTML node needs no change for this operation. */
export function assessWorkspaceHtmlLink(
  link: WorkspaceLinkUnevaluated,
  scope: WorkspaceHtmlLinkOperationScope,
): { unaffected: boolean; targets: string[] } | null {
  if (link.reason !== 'html' || !link.htmlTargets?.length) return null;
  // The renderer decodes the source URL before deriving its relative base.
  // Keep encoded source paths strict until that base has an explicit contract.
  if (link.sourcePath.includes('%') && link.htmlTargets.some((literal) => !literal.startsWith('/'))) return null;
  const targets: string[] = [];
  let unaffected = !scope.sourceScopes.some((root) => within(link.sourcePath, root));
  for (const literal of link.htmlTargets) {
    // The parser has already decoded entities/percent escapes exactly once.
    const target = path.posix.normalize(literal.startsWith('/') ? literal.slice(1)
      : path.posix.join(path.posix.dirname(link.sourcePath), literal));
    if (!target || target === '.' || target === '..' || target.startsWith('../')) return null;
    targets.push(target);
    if (scope.targetScopes.some((root) => within(target, root))) unaffected = false;
    const before = resolveExactWorkspaceLink(literal, link.sourcePath, scope.beforePaths);
    const after = resolveExactWorkspaceLink(literal, link.sourcePath, scope.afterPaths);
    if (before.status !== after.status || before.path !== after.path) unaffected = false;
  }
  return { unaffected, targets: [...new Set(targets)] };
}
