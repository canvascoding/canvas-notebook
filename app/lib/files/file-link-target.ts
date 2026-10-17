export type WorkspaceFileLinkTarget = {
  workspaceId: string;
  path: string;
  documentId: string | null;
  lineageId: string | null;
};

export function workspaceFileLinkHref(target: WorkspaceFileLinkTarget): string {
  const params = new URLSearchParams({ workspaceId: target.workspaceId, path: target.path });
  if (target.documentId) params.set('documentId', target.documentId);
  if (target.lineageId) params.set('lineageId', target.lineageId);
  return `/notebook?${params}`;
}

export function matchesWorkspaceFileLinkIdentity(
  file: { collaboration?: { document?: { id: string } | null; lineageId?: string | null; latestRevision?: { lineageId?: string | null } | null } | null;
    revision?: { lineageId?: string | null } | null } | null | undefined,
  expected: { expectedDocumentId?: string; expectedLineageId?: string },
): boolean {
  return (!expected.expectedDocumentId || file?.collaboration?.document?.id === expected.expectedDocumentId)
    && (!expected.expectedLineageId
      || (file?.collaboration?.lineageId ?? file?.revision?.lineageId ?? file?.collaboration?.latestRevision?.lineageId) === expected.expectedLineageId);
}
