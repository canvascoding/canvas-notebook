import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  WORKSPACE_LINK_CONTRACT_VERSION_V1,
  type WorkspaceFileLinkEditV1,
  type WorkspaceFileOperationKindV1,
  type WorkspaceFileOperationPlanV1,
  type WorkspaceFilePathMappingV1,
  type WorkspaceLinkCoverageV1,
  type WorkspaceLinkOmissionReasonV1,
  type WorkspaceLinkTargetRangeV1,
} from './workspace-link-contract-v1';
import {
  buildWorkspaceLinkIndexFromDocuments,
  type WorkspaceLinkEdge,
} from './workspace-link-index-core';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { assessWorkspaceFileOperationLinks } from './workspace-file-operation-link-assessment';

export type WorkspacePlannerEntry = {
  /** A snapshot identity, such as a file ID; it must not be derived from the path. */
  identity: string;
  kind: 'file' | 'directory';
  path: string;
  /** Required for binary files when their bytes are versioned by the caller. */
  contentHash?: string | null;
  /** Only Markdown source content is supplied; binary targets are never read. */
  markdownContent?: string;
  omissionReason?: WorkspaceLinkOmissionReasonV1;
};

export type WorkspacePlannerSnapshot = {
  workspaceId: string;
  entries: readonly WorkspacePlannerEntry[];
};

export type WorkspaceFileOperationPlanRequest = {
  kind: WorkspaceFileOperationKindV1;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  /** Each destination is the final chosen name, after any name-collision selection. */
  selections: ReadonlyArray<{ sourcePath: string; destinationPath: string }>;
  snapshots: readonly WorkspacePlannerSnapshot[];
};

export type WorkspacePlannerIssue = {
  code:
    | 'unsupported-operation'
    | 'cross-workspace-move'
    | 'invalid-path'
    | 'missing-source'
    | 'overlapping-selection'
    | 'destination-collision'
    | 'duplicate-destination'
    | 'directory-cycle'
    | 'incomplete-index'
    | 'uncopied-cross-workspace-target'
    | 'stale-content'
    | 'unsupported-target-format';
  workspaceId: string;
  path: string;
  detail: string;
};

export type WorkspaceFileOperationPreview = WorkspaceFileOperationPlanV1 & {
  readiness: 'ready' | 'blocked';
  issues: WorkspacePlannerIssue[];
  /** Complete rewritten Markdown contents, keyed by final workspace and path. */
  previewContents: Array<{ workspaceId: string; path: string; content: string }>;
};

type LocatedEntry = WorkspacePlannerEntry & { workspaceId: string };
type SourceContent = { content: string; hash: string; path: string; workspaceId: string };
type PendingEdit = WorkspaceFileLinkEditV1;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Recreate the v1 plan identity from the exact public preview body. */
export function computeWorkspaceFileOperationPlanId(
  preview: Omit<WorkspaceFileOperationPreview, 'planId' | 'readiness'>
    & Partial<Pick<WorkspaceFileOperationPreview, 'planId' | 'readiness'>>,
): string {
  const { planId: _planId, readiness: _readiness, issues, previewContents, ...basePlan } = preview;
  void _planId;
  void _readiness;
  return hash(JSON.stringify({ ...basePlan, issues, previewContents }));
}

function isMarkdown(pathValue: string): boolean {
  return /\.(?:md|markdown)$/iu.test(pathValue);
}

function isValidPath(pathValue: string): boolean {
  return Boolean(pathValue)
    && !pathValue.startsWith('/')
    && !pathValue.includes('\\')
    && !pathValue.includes('\0')
    && pathValue.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function isWithin(pathValue: string, parent: string): boolean {
  return pathValue === parent || pathValue.startsWith(`${parent}/`);
}

function splitLiteral(edge: WorkspaceLinkEdge): { pathLiteral: string; suffix: string } {
  const literal = edge.targetLiteral;
  for (let index = 0; index < literal.length; index += 1) {
    if (literal[index] !== '#') continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && literal[before] === '\\'; before -= 1) escapes += 1;
    if (escapes % 2 === 0) {
      return { pathLiteral: literal.slice(0, index), suffix: literal.slice(index) };
    }
  }
  return { pathLiteral: literal, suffix: '' };
}

function formatMarkdownPath(
  oldLiteral: string,
  newTargetPath: string,
  newSourcePath: string,
  sourceContent: string,
  range: WorkspaceLinkTargetRangeV1,
): string | null {
  // Legacy notebook URLs have a query-string path, not a Markdown path span.
  // They remain visible as unsupported until a byte-preserving URL formatter exists.
  if (/^(?:https?:\/\/|\/notebook\?)/iu.test(oldLiteral) && oldLiteral.includes('path=')) return null;
  const rootRelative = oldLiteral.startsWith('/');
  const relative = path.posix.relative(path.posix.dirname(newSourcePath), newTargetPath);
  let next = rootRelative ? `/${newTargetPath}` : relative || path.posix.basename(newTargetPath);
  if (!rootRelative && oldLiteral.startsWith('./') && !next.startsWith('../')) next = `./${next}`;
  if (!rootRelative && /^[a-z][a-z0-9+.-]*:/iu.test(next)) next = `./${next}`;
  const angleWrapped = sourceContent[range.startUtf16 - 1] === '<'
    && sourceContent[range.endUtf16] === '>';
  const hadPercentEncoding = /%[0-9a-f]{2}/iu.test(oldLiteral);
  const hadEscapes = /\\[()#|\\]/u.test(oldLiteral);
  if (hadPercentEncoding) next = encodeURI(next);
  else if (hadEscapes) next = next.replace(/[()#|\\]/gu, '\\$&');
  if (!hadPercentEncoding) next = next.replace(/%/gu, '%25');
  if (!angleWrapped) {
    const balance = Array.from(next).reduce((depth, character) => depth + (character === '(' ? 1 : character === ')' ? -1 : 0), 0);
    const hasEarlyClosing = next.split('').reduce((state, character) => {
      const depth = state.depth + (character === '(' ? 1 : character === ')' ? -1 : 0);
      return { depth, early: state.early || depth < 0 };
    }, { depth: 0, early: false }).early;
    if (!hadEscapes && (balance !== 0 || hasEarlyClosing)) next = next.replace(/\(/gu, '%28').replace(/\)/gu, '%29');
    next = next.replace(/ /gu, '%20').replace(/(?<!\\)#/gu, '%23').replace(/\?/gu, '%3F')
      .replace(/</gu, '%3C').replace(/>/gu, '%3E');
  } else {
    next = next.replace(/(?<!\\)#/gu, '%23').replace(/\?/gu, '%3F')
      .replace(/</gu, '%3C').replace(/(?<!\\)>/gu, '%3E');
  }
  return next;
}

function formatTarget(
  edge: WorkspaceLinkEdge,
  newTargetPath: string,
  newSourcePath: string,
  sourceContent: string,
): string | null {
  const { pathLiteral, suffix } = splitLiteral(edge);
  if (edge.kind === 'markdown') {
    const formatted = formatMarkdownPath(pathLiteral, newTargetPath, newSourcePath, sourceContent, edge.targetRange);
    return formatted === null ? null : `${formatted}${suffix}`;
  }
  // The current Wiki parser treats every '#' as a fragment delimiter and
  // cannot parse ']' inside a target. Never generate a silently broken link.
  if (/[#|\]]/u.test(newTargetPath)) return null;
  const hadMarkdownExtension = /\.(?:md|markdown)$/iu.test(pathLiteral);
  const wikiPath = !hadMarkdownExtension && isMarkdown(newTargetPath)
    ? newTargetPath.replace(/\.(?:md|markdown)$/iu, '')
    : newTargetPath;
  return `${wikiPath.replace(/[|\\]/gu, '\\$&')}${suffix}`;
}

function freezePlan<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezePlan);
    Object.freeze(value);
  }
  return value;
}

/** Pure Rename/Move/Copy planner. The caller supplies an immutable filesystem snapshot. */
export function createWorkspaceFileOperationPlan(request: WorkspaceFileOperationPlanRequest): WorkspaceFileOperationPreview {
  const issues: WorkspacePlannerIssue[] = [];
  const issue = (code: WorkspacePlannerIssue['code'], workspaceId: string, pathValue: string, detail: string): void => {
    issues.push({ code, workspaceId, path: pathValue, detail });
  };
  const snapshotMap = new Map(request.snapshots.map((snapshot) => [snapshot.workspaceId, snapshot]));
  const sourceSnapshot = snapshotMap.get(request.sourceWorkspaceId);
  const destinationSnapshot = snapshotMap.get(request.destinationWorkspaceId);
  if (!sourceSnapshot || !destinationSnapshot) {
    throw new Error('Both source and destination workspace snapshots are required.');
  }
  const entryMap = new Map<string, LocatedEntry>();
  for (const snapshot of request.snapshots) {
    for (const entry of snapshot.entries) {
      if (!isValidPath(entry.path)) issue('invalid-path', snapshot.workspaceId, entry.path, 'Snapshot path is not canonical.');
      const key = `${snapshot.workspaceId}\0${entry.path}`;
      if (entryMap.has(key)) throw new Error(`Duplicate snapshot path: ${snapshot.workspaceId}:${entry.path}`);
      entryMap.set(key, { ...entry, workspaceId: snapshot.workspaceId });
    }
  }
  const sourceEntries = sourceSnapshot.entries;
  const destinationEntries = destinationSnapshot.entries;
  const mapped = new Map<string, WorkspaceFilePathMappingV1>();
  const selectedPaths = new Set<string>();
  if (!['rename', 'move', 'copy'].includes(request.kind)) {
    issue('unsupported-operation', request.sourceWorkspaceId, '', `${request.kind} is outside the FL-03 planner.`);
  }
  if (request.kind !== 'copy' && request.sourceWorkspaceId !== request.destinationWorkspaceId) {
    issue('cross-workspace-move', request.sourceWorkspaceId, '', 'Cross-workspace moves need a separate incoming-link contract.');
  }
  for (const selection of request.selections) {
    const { sourcePath, destinationPath } = selection;
    if (!isValidPath(sourcePath) || !isValidPath(destinationPath)) {
      issue('invalid-path', request.sourceWorkspaceId, sourcePath, 'Selection path is not canonical.');
      continue;
    }
    const selected = sourceEntries.find((entry) => entry.path === sourcePath);
    if (!selected) {
      issue('missing-source', request.sourceWorkspaceId, sourcePath, 'Selected path is absent from the source snapshot.');
      continue;
    }
    if (selected.kind === 'directory' && isWithin(destinationPath, sourcePath)
      && request.sourceWorkspaceId === request.destinationWorkspaceId) {
      issue('directory-cycle', request.sourceWorkspaceId, destinationPath, 'Cannot move or copy a directory into itself.');
    }
    for (const entry of sourceEntries.filter((candidate) => isWithin(candidate.path, sourcePath))) {
      if (selectedPaths.has(entry.path)) {
        issue('overlapping-selection', request.sourceWorkspaceId, entry.path, 'Source is selected more than once.');
        continue;
      }
      selectedPaths.add(entry.path);
      const suffix = entry.path.slice(sourcePath.length);
      mapped.set(entry.path, {
        sourceWorkspaceId: request.sourceWorkspaceId,
        sourcePath: entry.path,
        destinationWorkspaceId: request.destinationWorkspaceId,
        destinationPath: `${destinationPath}${suffix}`,
        sourceIdentity: entry.identity,
      });
    }
  }

  const pathMappings = Array.from(mapped.values()).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  const collisions: WorkspaceFileOperationPlanV1['collisions'] = [];
  const mappedDestinationKeys = new Set<string>();
  for (const mapping of pathMappings) {
    const key = `${mapping.destinationWorkspaceId}\0${mapping.destinationPath}`;
    if (mappedDestinationKeys.has(key)) issue('duplicate-destination', mapping.destinationWorkspaceId, mapping.destinationPath, 'Multiple sources map here.');
    mappedDestinationKeys.add(key);
    const occupied = destinationEntries.find((entry) => entry.path === mapping.destinationPath);
    const vacated = request.kind !== 'copy' && request.sourceWorkspaceId === request.destinationWorkspaceId
      && mapped.has(mapping.destinationPath);
    if (occupied && !vacated && (request.kind === 'copy' || occupied.identity !== mapping.sourceIdentity)) {
      collisions.push({ workspaceId: request.destinationWorkspaceId, path: mapping.destinationPath });
      issue('destination-collision', request.destinationWorkspaceId, mapping.destinationPath, 'Final destination is occupied.');
    }
  }

  const contents = new Map<string, SourceContent>();
  const omitted: Array<{ path: string; reason: 'too-large' | 'unreadable' }> = [];
  const sources: Array<{ path: string; content: string }> = [];
  for (const entry of sourceEntries) {
    if (entry.kind !== 'file' || !isMarkdown(entry.path)) continue;
    const bytes = entry.markdownContent === undefined ? 0 : Buffer.byteLength(entry.markdownContent, 'utf8');
    if (entry.markdownContent === undefined || bytes > MAX_INDEXED_MARKDOWN_BYTES || entry.omissionReason) {
      omitted.push({ path: entry.path, reason: bytes > MAX_INDEXED_MARKDOWN_BYTES || entry.omissionReason === 'source-too-large' ? 'too-large' : 'unreadable' });
      continue;
    }
    const contentHash = hash(entry.markdownContent);
    if (entry.contentHash && entry.contentHash !== contentHash) {
      issue('stale-content', sourceSnapshot.workspaceId, entry.path, 'Supplied Markdown hash differs from supplied bytes.');
    }
    contents.set(`${sourceSnapshot.workspaceId}\0${entry.path}`, {
      content: entry.markdownContent, hash: contentHash, path: entry.path, workspaceId: sourceSnapshot.workspaceId,
    });
    sources.push({ path: entry.path, content: entry.markdownContent });
  }
  const sourceIndex = buildWorkspaceLinkIndexFromDocuments(
    sources, new Date(0), sourceEntries.filter((entry) => entry.kind === 'file').map((entry) => entry.path), omitted,
  );
  const coverage: WorkspaceLinkCoverageV1 = {
    complete: sourceIndex.coverage.complete,
    omittedSources: sourceIndex.coverage.omittedSources.map((omitted) => ({
      ...omitted,
      reason: sourceEntries.find((entry) => entry.path === omitted.path)?.omissionReason ?? omitted.reason,
    })),
    unresolvedLinks: [...sourceIndex.coverage.unresolvedLinks],
  };
  const pending: PendingEdit[] = [];
  for (const edge of sourceIndex.edges) {
    if (edge.status !== 'resolved' || !edge.targetPath) continue;
    const sourceMapping = mapped.get(edge.sourcePath);
    const targetMapping = mapped.get(edge.targetPath);
    if (request.kind === 'copy' && !sourceMapping) continue;
    if (request.kind !== 'copy' && !sourceMapping && !targetMapping) continue;
    const writeWorkspaceId = request.kind === 'copy' ? request.destinationWorkspaceId : request.sourceWorkspaceId;
    const newSourcePath = sourceMapping?.destinationPath ?? edge.sourcePath;
    if (request.kind === 'copy' && request.sourceWorkspaceId !== request.destinationWorkspaceId && !targetMapping) {
      issue('uncopied-cross-workspace-target', request.destinationWorkspaceId, newSourcePath,
        `${edge.targetPath} belongs to the source workspace and is not copied.`);
      continue;
    }
    const newTargetPath = targetMapping?.destinationPath ?? edge.targetPath;
    const source = contents.get(`${request.sourceWorkspaceId}\0${edge.sourcePath}`);
    if (!source) continue;
    const nextTargetLiteral = formatTarget(edge, newTargetPath, newSourcePath, source.content);
    if (nextTargetLiteral === null) {
      issue('unsupported-target-format', request.sourceWorkspaceId, edge.sourcePath, edge.targetLiteral);
      continue;
    }
    if (nextTargetLiteral === edge.targetLiteral) continue;
    if (source.content.slice(edge.targetRange.startUtf16, edge.targetRange.endUtf16) !== edge.targetLiteral) {
      issue('stale-content', request.sourceWorkspaceId, edge.sourcePath, 'Link target span no longer matches the index.');
      continue;
    }
    pending.push({
      sourceWorkspaceId: request.sourceWorkspaceId,
      destinationWorkspaceId: writeWorkspaceId,
      sourcePathBefore: edge.sourcePath,
      sourcePathAfter: newSourcePath,
      expectedContentHash: source.hash,
      targetRange: edge.targetRange,
      previousTargetLiteral: edge.targetLiteral,
      nextTargetLiteral,
    });
  }
  // Preserve all unrelated bytes: edit only target literals, from right to left.
  const pendingBySource = new Map<string, PendingEdit[]>();
  for (const edit of pending) {
    const key = `${edit.sourceWorkspaceId}\0${edit.sourcePathBefore}`;
    const edits = pendingBySource.get(key) ?? [];
    edits.push(edit);
    pendingBySource.set(key, edits);
  }
  const previewContents: WorkspaceFileOperationPreview['previewContents'] = [];
  for (const [key, edits] of pendingBySource) {
    const source = contents.get(key)!;
    let result = source.content;
    for (const edit of edits.sort((a, b) => b.targetRange.startUtf16 - a.targetRange.startUtf16)) {
      result = `${result.slice(0, edit.targetRange.startUtf16)}${edit.nextTargetLiteral}${result.slice(edit.targetRange.endUtf16)}`;
    }
    previewContents.push({ workspaceId: edits[0].destinationWorkspaceId, path: edits[0].sourcePathAfter, content: result });
  }
  const linkEdits = [...pending]
    .sort((a, b) => a.sourcePathBefore.localeCompare(b.sourcePathBefore) || a.targetRange.startUtf16 - b.targetRange.startUtf16);
  const { linkAssessment, destinationCoverage } = assessWorkspaceFileOperationLinks({
    request, pathMappings, sourceIndex, previewContents,
  });
  if (destinationCoverage) {
    coverage.complete &&= destinationCoverage.complete;
    coverage.omittedSources.push(...destinationCoverage.omittedSources);
    coverage.unresolvedLinks.push(...destinationCoverage.unresolvedLinks);
  }
  for (const blocker of linkAssessment.blockers) {
    issue('incomplete-index', blocker.workspaceId ?? request.sourceWorkspaceId, blocker.sourcePath,
      `${blocker.reason}: ${blocker.targetLiteral || blocker.sourcePath} (${blocker.status}).`);
  }
  const expectedPathState = new Map<string, WorkspaceFileOperationPlanV1['expectedPathState'][number]>();
  const expect = (workspaceId: string, pathValue: string): void => {
    const key = `${workspaceId}\0${pathValue}`;
    if (expectedPathState.has(key)) return;
    const entry = entryMap.get(key);
    const source = contents.get(key);
    expectedPathState.set(key, {
      workspaceId, path: pathValue, identity: entry?.identity ?? null,
      contentHash: source?.hash ?? entry?.contentHash ?? null,
    });
  };
  for (const mapping of pathMappings) {
    expect(mapping.sourceWorkspaceId, mapping.sourcePath);
    expect(mapping.destinationWorkspaceId, mapping.destinationPath);
  }
  for (const edit of linkEdits) expect(edit.sourceWorkspaceId, edit.sourcePathBefore);
  const basePlan = {
    contractVersion: WORKSPACE_LINK_CONTRACT_VERSION_V1,
    kind: request.kind,
    status: 'planned' as const,
    pathMappings,
    linkEdits,
    coverage,
    linkAssessment,
    expectedPathState: Array.from(expectedPathState.values()).sort((a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path)),
    collisions,
    recoveryReady: false,
  };
  previewContents.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path));
  const planId = computeWorkspaceFileOperationPlanId({ ...basePlan, issues, previewContents });
  return freezePlan({
    ...basePlan, planId,
    readiness: issues.length ? 'blocked' as const : 'ready' as const,
    issues,
    previewContents,
  });
}
