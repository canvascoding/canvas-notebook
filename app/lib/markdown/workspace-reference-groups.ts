import type {
  WorkspaceLinkDocument,
  WorkspaceLinkEdge,
} from './workspace-link-index-core';
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
    const path = direction === 'incoming' ? edge.sourcePath : edge.targetPath;
    if (!path) continue;
    const existing = groups.get(path);
    if (existing) {
      existing.edges.push(edge);
      if (direction === 'incoming' && typeof existing.reference.focusOffset === 'number') {
        existing.reference.focusOffset = Math.min(existing.reference.focusOffset, edge.start);
      }
      continue;
    }

    const document = documentByPath.get(path);
    groups.set(path, {
      edges: [edge],
      reference: {
        blockId: direction === 'outgoing' ? edge.blockId : null,
        focusOffset: direction === 'incoming' ? edge.start : null,
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
