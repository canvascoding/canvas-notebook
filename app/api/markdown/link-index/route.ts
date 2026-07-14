import { NextRequest } from 'next/server';

import {
  applyRateLimit,
  jsonServerError,
  jsonSuccess,
} from '@/app/lib/api/route-helpers';
import { buildWorkspaceLinkIndex } from '@/app/lib/markdown/workspace-link-index';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;

  const rateLimitResponse = applyRateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'markdown-link-index',
  });
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const index = await buildWorkspaceLinkIndex(workspaceFileOptions(workspaceResult.workspace));
    const path = new URL(request.url).searchParams.get('path')?.trim();
    if (!path) return jsonSuccess({ index });

    return jsonSuccess({
      document: index.documents.find((document) => document.path === path) ?? null,
      backlinks: index.backlinks[path] ?? [],
      outgoing: index.edges.filter((edge) => edge.sourcePath === path),
      brokenLinks: index.brokenLinks.filter((edge) => edge.sourcePath === path),
      generatedAt: index.generatedAt,
    });
  } catch (error) {
    return jsonServerError('[Markdown Link Index] Failed to build index:', error, 'Failed to build link index');
  }
}
