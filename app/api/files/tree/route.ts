import { NextRequest, NextResponse } from 'next/server';
import { buildFileTree } from '@/app/lib/filesystem/workspace-files';
import { buildFileTreeCacheKey, fileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPublicShareAnnotations } from '@/app/lib/public-sharing/public-file-shares';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

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
    const depth = parseInt(searchParams.get('depth') || '4');
    const noCache = searchParams.has('noCache');

    const cacheKey = buildFileTreeCacheKey(path, depth, workspaceResult.workspace.workspaceId);
    if (!noCache) {
      const cached = fileTreeCache.get(cacheKey);
      if (cached) {
        return NextResponse.json({ success: true, data: cached, cached: true });
      }
    }

    const tree = await buildFileTree(path, depth, 0, fileOptions);
    const annotations = await getPublicShareAnnotations(collectFilePaths(tree), null, workspaceResult.workspace);
    attachPublicShareAnnotations(tree, annotations);
    fileTreeCache.set(cacheKey, tree);

    const headers = new Headers();
    headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');

    return NextResponse.json({ success: true, data: tree }, { headers });
  } catch (error) {
    // If the directory doesn't exist, it's not a server error, just return an empty tree.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return NextResponse.json({ success: true, data: [] });
    }
    
    console.error('[API] File tree error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load file tree';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
