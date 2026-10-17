import type {
  WorkspaceLinkDocument,
} from './workspace-link-index-core';
import type { WorkspaceLinkReadEdge as WorkspaceLinkEdge } from './workspace-document-link-index-contract';
import {
  workspaceDocumentTitleFromPath,
  type WorkspaceDocumentReference,
} from './workspace-document-preview';

export type WorkspaceReferenceDirection = 'incoming' | 'outgoing';

export type WorkspaceReferenceGroup = {
  edges: WorkspaceLinkEdge[];
  reference: WorkspaceDocumentReference;
};

export function workspaceReferenceDirectory(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  const separator = normalized.lastIndexOf('/');
  return separator > 0 ? normalized.slice(0, separator) : null;
}

export function groupWorkspaceReferenceEdges(
  edges: WorkspaceLinkEdge[],
  documents: WorkspaceLinkDocument[],
  direction: WorkspaceReferenceDirection,
): WorkspaceReferenceGroup[] {
  const documentByPath = new Map(documents.map((document) => [document.path, document]));
  const groups = new Map<string, WorkspaceReferenceGroup>();

  for (const edge of edges) {
    const sourceOffset = edge.sourcePreview?.focusOffset
      ?? ('start' in edge && typeof edge.start === 'number' ? edge.start : null);
    const path = direction === 'incoming' ? edge.sourcePath : edge.targetPath;
    if (!path) continue;
    const existing = groups.get(path);
    if (existing) {
      existing.edges.push(edge);
      if (direction === 'incoming' && sourceOffset !== null) {
        existing.reference.focusOffset = existing.reference.focusOffset === null
          || existing.reference.focusOffset === undefined ? sourceOffset : Math.min(existing.reference.focusOffset, sourceOffset);
      }
      continue;
    }

    const document = documentByPath.get(path);
    groups.set(path, {
      edges: [edge],
      reference: {
        blockId: direction === 'outgoing' ? edge.blockId : null,
        focusOffset: direction === 'incoming' ? sourceOffset : null,
        heading: direction === 'outgoing' ? edge.heading : null,
        path,
        title: document?.title || workspaceDocumentTitleFromPath(path),
      },
    });
  }

  return Array.from(groups.values()).sort((left, right) => (
    left.reference.title.localeCompare(right.reference.title)
    || left.reference.path.localeCompare(right.reference.path)
  ));
}
