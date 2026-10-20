import 'server-only';
import { readWorkspaceFileLinkTargets } from '@/app/lib/files/file-link-service';
import { buildDirectMcpDocumentUrl } from './document-edit-contract';
import type { WorkspaceFileLinkTarget } from '@/app/lib/files/file-link-target';

export function directMcpFileLinkFields(target: WorkspaceFileLinkTarget) {
  return { document_id: target.documentId, lineage_id: target.lineageId,
    document_url: buildDirectMcpDocumentUrl(target) };
}

export async function readDirectMcpFileLinks(workspaceId: string, paths: string[]) {
  const targets = await readWorkspaceFileLinkTargets(workspaceId, paths);
  return new Map(paths.map(path => [path, directMcpFileLinkFields(targets.get(path)
    ?? { workspaceId, path, documentId: null, lineageId: null })]));
}
