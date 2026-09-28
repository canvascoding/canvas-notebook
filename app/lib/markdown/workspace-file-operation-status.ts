import type { WorkspaceLinkIndex } from './workspace-link-index-core';
import type { WorkspaceLinkRenameResult } from './workspace-link-index';

export type WorkspaceOperationLinkStatus = 'complete' | 'partial' | 'incomplete';

function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

/** Describes the limits of the legacy rename writer without claiming its edits are atomic. */
export function assessWorkspaceRenameLinks(input: {
  index: WorkspaceLinkIndex | null;
  oldPath: string;
  newPath: string;
  updateLinks: boolean;
  result: WorkspaceLinkRenameResult;
  indexError?: string | null;
}): { status: WorkspaceOperationLinkStatus; warnings: string[] } {
  const warnings = [...input.result.warnings];
  if (!input.updateLinks) {
    warnings.push('Local Markdown links were not checked or updated for this rename.');
    return { status: 'incomplete', warnings };
  }
  if (!input.index) {
    warnings.push(`Local Markdown links could not be checked: ${input.indexError || 'link index unavailable'}.`);
    return { status: 'incomplete', warnings };
  }

  const affected = input.index.edges.filter((edge) => edge.status === 'resolved'
    && (isWithin(edge.sourcePath, input.oldPath)
      || Boolean(edge.targetPath && isWithin(edge.targetPath, input.oldPath))));
  const legacyEligible = affected.filter((edge) => edge.kind === 'wiki'
    && edge.targetPath && isWithin(edge.targetPath, input.oldPath));
  const unsupported = affected.length - legacyEligible.length;
  if (unsupported > 0) {
    warnings.push(`${unsupported} local link(s) may need rewriting; the current rename writer handles incoming Wiki links only.`);
  }
  if (input.result.updatedLinks < legacyEligible.length) {
    warnings.push(`${legacyEligible.length - input.result.updatedLinks} incoming Wiki link(s) were not confirmed updated.`);
  }
  if (legacyEligible.length > 0 && /[#|\]]/u.test(input.newPath)) {
    warnings.push('The new path contains Wiki-link syntax characters; rewritten links may be invalid.');
  }
  if (legacyEligible.length > 0) {
    warnings.push('Updated Wiki links were not reparsed after writing.');
  }
  if (!input.index.coverage.complete) {
    warnings.push(`Link scan incomplete: ${input.index.coverage.omittedSources.length} omitted Markdown source(s), ${input.index.coverage.unresolvedLinks.length} unresolved or unevaluated link(s).`);
  }
  const hasMissedEdits = unsupported > 0 || input.result.updatedLinks < legacyEligible.length
    || input.result.warnings.length > 0;
  return {
    status: hasMissedEdits ? 'partial' : input.index.coverage.complete && legacyEligible.length === 0 ? 'complete' : 'incomplete',
    warnings,
  };
}
