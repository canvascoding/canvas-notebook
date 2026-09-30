import path from 'node:path';

import type {
  WorkspaceFileOperationLinkAssessmentV1,
  WorkspaceFilePathMappingV1,
  WorkspaceLinkCoverageV1,
} from './workspace-link-contract-v1';
import {
  buildWorkspaceLinkIndexFromDocuments,
  type WorkspaceLinkDocumentSource,
  type WorkspaceLinkEdge,
  type WorkspaceLinkIndex,
} from './workspace-link-index-core';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { parseWorkspaceMarkdownHref } from './workspace-local-link-parser';
import type { WorkspaceFileOperationPlanRequest } from './workspace-file-operation-planner';

type AssessmentRequest = {
  request: WorkspaceFileOperationPlanRequest;
  pathMappings: WorkspaceFilePathMappingV1[];
  sourceIndex: WorkspaceLinkIndex;
  previewContents: Array<{ workspaceId: string; path: string; content: string }>;
};

function sourceEdges(index: WorkspaceLinkIndex): Map<string, WorkspaceLinkEdge[]> {
  const grouped = new Map<string, WorkspaceLinkEdge[]>();
  for (const edge of index.edges) {
    const edges = grouped.get(edge.sourcePath) ?? [];
    edges.push(edge);
    grouped.set(edge.sourcePath, edges);
  }
  return grouped;
}

function sortedCandidates(edge: WorkspaceLinkEdge): string {
  return JSON.stringify([...edge.candidates].sort());
}

/**
 * Re-resolve the complete virtual result before treating an existing broken
 * link as unrelated. Comparing only selected directories misses Wiki aliases,
 * basename collisions and links that become newly resolvable at a destination.
 */
export function assessWorkspaceFileOperationLinks({
  request, pathMappings, sourceIndex, previewContents,
}: AssessmentRequest): {
  linkAssessment: WorkspaceFileOperationLinkAssessmentV1;
  destinationCoverage?: WorkspaceLinkCoverageV1;
} {
  const assessment: WorkspaceFileOperationLinkAssessmentV1 = {
    version: 1, complete: true, warnings: [], blockers: [],
  };
  const before = new Map<string, WorkspaceLinkIndex>([[request.sourceWorkspaceId, sourceIndex]]);
  const sourceMappings = new Map(pathMappings.map((mapping) => [mapping.sourcePath, mapping]));
  const entriesByWorkspace = new Map(request.snapshots.map((snapshot) => [snapshot.workspaceId,
    new Map(snapshot.entries.map((entry) => [entry.path, entry]))]));
  const sourceTargets = new Set(sourceIndex.targetPaths);
  const sourceDocuments = new Set(sourceIndex.documents.map((document) => document.path));
  const destinationSnapshot = request.snapshots.find((snapshot) => snapshot.workspaceId === request.destinationWorkspaceId)!;
  if (request.sourceWorkspaceId !== request.destinationWorkspaceId) {
    const documents: WorkspaceLinkDocumentSource[] = [];
    const omitted: WorkspaceLinkIndex['omittedDocuments'] = [];
    for (const entry of destinationSnapshot.entries) {
      if (entry.kind !== 'file' || !/\.(?:md|markdown)$/iu.test(entry.path)) continue;
      const tooLarge = entry.markdownContent !== undefined
        && Buffer.byteLength(entry.markdownContent, 'utf8') > MAX_INDEXED_MARKDOWN_BYTES;
      if (entry.markdownContent === undefined || tooLarge || entry.omissionReason) {
        omitted.push({ path: entry.path, reason: tooLarge || entry.omissionReason === 'source-too-large' ? 'too-large' : 'unreadable' });
      } else documents.push({ path: entry.path, content: entry.markdownContent });
    }
    before.set(request.destinationWorkspaceId, buildWorkspaceLinkIndexFromDocuments(
      documents, new Date(0), destinationSnapshot.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path), omitted,
    ));
  }

  const documentsAfter = new Map<string, Map<string, WorkspaceLinkDocumentSource>>();
  const pathsAfter = new Map<string, Set<string>>();
  for (const [workspaceId, index] of before) {
    const entries = entriesByWorkspace.get(workspaceId)!;
    documentsAfter.set(workspaceId, new Map(index.documents.map((document) => [document.path, {
      path: document.path, content: entries.get(document.path)!.markdownContent!,
    }])));
    pathsAfter.set(workspaceId, new Set(index.targetPaths));
  }
  for (const mapping of pathMappings) {
    const sourcePathSet = pathsAfter.get(mapping.sourceWorkspaceId)!;
    // Directories never enter targetPaths or the Markdown candidate catalogue.
    if (!sourceTargets.has(mapping.sourcePath)) continue;
    if (request.kind !== 'copy') {
      sourcePathSet.delete(mapping.sourcePath);
      documentsAfter.get(mapping.sourceWorkspaceId)!.delete(mapping.sourcePath);
    }
  }
  for (const mapping of pathMappings) {
    if (!sourceTargets.has(mapping.sourcePath)) continue;
    pathsAfter.get(mapping.destinationWorkspaceId)!.add(mapping.destinationPath);
    const entry = entriesByWorkspace.get(mapping.sourceWorkspaceId)!.get(mapping.sourcePath)!;
    if (sourceDocuments.has(mapping.sourcePath)) {
      documentsAfter.get(mapping.destinationWorkspaceId)!.set(mapping.destinationPath, {
        path: mapping.destinationPath, content: entry.markdownContent!,
      });
    }
  }
  for (const rewritten of previewContents) {
    documentsAfter.get(rewritten.workspaceId)!.set(rewritten.path, { path: rewritten.path, content: rewritten.content });
  }
  const afterEdges = new Map<string, Map<string, WorkspaceLinkEdge[]>>();
  for (const [workspaceId, documents] of documentsAfter) {
    const index = buildWorkspaceLinkIndexFromDocuments(Array.from(documents.values()), new Date(0), pathsAfter.get(workspaceId));
    afterEdges.set(workspaceId, sourceEdges(index));
  }

  const blockerKeys = new Set<string>();
  const block = (entry: WorkspaceFileOperationLinkAssessmentV1['blockers'][number]): void => {
    const key = JSON.stringify(entry);
    if (!blockerKeys.has(key)) {
      blockerKeys.add(key);
      assessment.blockers.push(entry);
    }
  };
  for (const [workspaceId, index] of before) {
    for (const omitted of index.coverage.omittedSources) {
      assessment.complete = false;
      block({ workspaceId, sourcePath: omitted.path, targetLiteral: '', status: 'omitted', reason: 'uninspected-source' });
    }
    for (const unevaluated of index.unevaluatedLinks) {
      assessment.complete = false;
      block({ workspaceId, sourcePath: unevaluated.sourcePath, targetLiteral: unevaluated.raw,
        status: 'not-evaluated', reason: 'unevaluated-link' });
    }
    for (const [sourcePath, edges] of sourceEdges(index)) {
      const mapping = workspaceId === request.sourceWorkspaceId ? sourceMappings.get(sourcePath) : undefined;
      for (const [ordinal, edge] of edges.entries()) {
        const relocated = Boolean(mapping);
        const destinations = mapping
          ? [{ workspaceId: mapping.destinationWorkspaceId, path: mapping.destinationPath, copied: request.kind === 'copy' }]
          : [{ workspaceId, path: sourcePath, copied: false }];
        if (mapping && request.kind === 'copy') destinations.push({ workspaceId, path: sourcePath, copied: false });
        if (edge.status !== 'resolved') {
          const parsedTarget = edge.kind === 'markdown' ? parseWorkspaceMarkdownHref(edge.targetLiteral) : null;
          const exactTarget = parsedTarget && path.posix.normalize(parsedTarget.path.startsWith('/')
            ? parsedTarget.path.slice(1) : path.posix.join(path.posix.dirname(sourcePath), parsedTarget.path));
          const involvedTarget = workspaceId === request.sourceWorkspaceId
            && (edge.candidates.some((candidate) => sourceMappings.has(candidate)) || Boolean(exactTarget
              && request.selections.some((selection) => exactTarget === selection.sourcePath || exactTarget.startsWith(`${selection.sourcePath}/`))));
          if (relocated || involvedTarget) {
            block({ workspaceId, sourcePath, targetLiteral: edge.targetLiteral, status: edge.status,
              reason: 'affected-unresolved-link' });
            continue;
          }
          const next = afterEdges.get(workspaceId)?.get(sourcePath)?.[ordinal];
          if (!next || next.kind !== edge.kind || next.syntax !== edge.syntax || next.targetLiteral !== edge.targetLiteral
            || next.status !== edge.status || next.targetPath !== edge.targetPath || sortedCandidates(next) !== sortedCandidates(edge)) {
            block({ workspaceId, sourcePath, targetLiteral: edge.targetLiteral, status: next?.status ?? 'not-evaluated',
              reason: 'resolution-changed' });
          } else assessment.warnings.push({ workspaceId, sourcePath, targetLiteral: edge.targetLiteral,
            status: edge.status, reason: 'unaffected-existing-link' });
          continue;
        }
        for (const destination of destinations) {
          const next = afterEdges.get(destination.workspaceId)?.get(destination.path)?.[ordinal];
          const targetMapping = workspaceId === request.sourceWorkspaceId && edge.targetPath
            ? sourceMappings.get(edge.targetPath) : undefined;
          const targetMoves = request.kind !== 'copy' || destination.copied;
          const expectedTarget = targetMoves ? targetMapping?.destinationPath ?? edge.targetPath : edge.targetPath;
          if (!next || next.kind !== edge.kind || next.syntax !== edge.syntax || next.status !== 'resolved'
            || next.targetPath !== expectedTarget) {
            block({ workspaceId, sourcePath, targetLiteral: edge.targetLiteral, status: next?.status ?? 'not-evaluated',
              reason: 'resolution-changed' });
          }
        }
      }
    }
  }
  const destinationIndex = request.sourceWorkspaceId !== request.destinationWorkspaceId
    ? before.get(request.destinationWorkspaceId) : undefined;
  const destinationCoverage = destinationIndex ? {
    ...destinationIndex.coverage,
    omittedSources: destinationIndex.coverage.omittedSources.map((omitted) => ({ ...omitted,
      reason: destinationSnapshot.entries.find((entry) => entry.path === omitted.path)?.omissionReason ?? omitted.reason,
    })),
  } : undefined;
  return { linkAssessment: assessment, destinationCoverage };
}
