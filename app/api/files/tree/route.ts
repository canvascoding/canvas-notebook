import { NextRequest, NextResponse } from 'next/server';
import { buildFileTree } from '@/app/lib/filesystem/workspace-files';
import { readWorkspaceDocumentTree, WorkspaceDocumentTreeError } from '@/app/lib/files/workspace-document-tree';
import { buildFileTreeCacheKey, fileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicShareAnnotations } from '@/app/lib/public-sharing/public-file-shares';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { enrichWorkspaceFileNodes } from '@/app/lib/files/workspace-file-metadata';

const DEFAULT_TREE_DEPTH = 4;
const MAX_TREE_DEPTH = 6;

function parseTreeDepth(value: string | null): number | null {
  if (value === null) return DEFAULT_TREE_DEPTH;
  if (!/^\d+$/.test(value)) return null;
  const depth = Number(value);
  return Number.isSafeInteger(depth) && depth >= 0 && depth <= MAX_TREE_DEPTH ? depth : null;
}

function collectFilePaths(nodes: Array<{ path: string; type: string; children?: unknown[] }>, result: string[] = []) {
  for (const node of nodes) {
    if (node.type === 'file') result.push(node.path);
    if (Array.isArray(node.children)) {
      collectFilePaths(node.children as Array<{ path: string; type: string; children?: unknown[] }>, result);
    }
  }
  return result;
}

function attachPublicShareAnnotations(
  nodes: Array<{ path: string; type: string; children?: unknown[]; publicShare?: unknown }>,
  annotations: Map<string, unknown>
) {
  for (const node of nodes) {
    if (node.type === 'file') {
      const annotation = annotations.get(node.path);
      if (annotation) node.publicShare = annotation;
    }
    if (Array.isArray(node.children)) {
      attachPublicShareAnnotations(
        node.children as Array<{ path: string; type: string; children?: unknown[]; publicShare?: unknown }>,
        annotations
      );
    }
  }
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'files-tree',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const { searchParams } = new URL(request.url);
    const path = searchParams.get('path') || '.';
    const depth = parseTreeDepth(searchParams.get('depth'));
    if (depth === null) {
      return NextResponse.json(
        { success: false, error: `depth must be an integer between 0 and ${MAX_TREE_DEPTH}` },
        { status: 400 },
      );
    }
    const noCache = searchParams.has('noCache');
    const includeStats = searchParams.get('stats') !== '0';

    const cacheKey = buildFileTreeCacheKey(path, depth, workspaceResult.workspace.workspaceId, includeStats);
    const tree = await readWorkspaceDocumentTree(workspaceResult.workspace, path, depth, {
      includeMetadata: includeStats,
    }, {
      buildPhysicalTree: async (directory, maxDepth, currentDepth, options) => {
        const cached = !noCache ? fileTreeCache.get(cacheKey) : null;
        if (cached) return cached;
        const physical = await buildFileTree(directory, maxDepth, currentDepth, { ...fileOptions, ...options });
        fileTreeCache.set(cacheKey, physical);
        return physical;
      },
    });
    const annotations = await getPublicShareAnnotations(collectFilePaths(tree), null, workspaceResult.workspace);
    attachPublicShareAnnotations(tree, annotations);
    const enrichedTree = await enrichWorkspaceFileNodes({
      nodes: tree,
      workspace: workspaceResult.workspace,
      userId: workspaceResult.session.user.id,
    });

    const headers = new Headers();
    headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');

    return NextResponse.json({ success: true, data: enrichedTree }, { headers });
  } catch (error) {
    if (error instanceof WorkspaceDocumentTreeError && error.code === 'TREE_DIRECTORY_NOT_FOUND') {
      return NextResponse.json({ success: true, data: [] });
    }
    console.error('[API] File tree error:', error);
    const status = error && typeof error === 'object' && 'status' in error
      && typeof error.status === 'number' && [400, 403, 409, 413].includes(error.status) ? error.status : 500;
    const code = error instanceof WorkspaceDocumentTreeError ? error.code
      : status === 413 ? 'NATIVE_CATALOGUE_TOO_LARGE' : status === 409 ? 'TREE_SOURCE_CHANGED' : undefined;
    const message = error instanceof WorkspaceDocumentTreeError ? error.message : 'Failed to load file tree';
    return NextResponse.json(
      { success: false, error: message, ...(code ? { code } : {}) },
      { status }
    );
  }
}
