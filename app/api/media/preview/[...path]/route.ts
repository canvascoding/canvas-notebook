import { NextRequest, NextResponse } from 'next/server';
import { createWorkspaceHtmlPreviewResponse } from '@/app/lib/html-preview-response';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const WORKSPACE_HTML_PREVIEW_PREFIX = '/api/media/preview';
const WORKSPACE_PREVIEW_SCOPE_SEGMENT = '__workspace';

function parsePreviewPath(pathParts: string[]) {
  if (pathParts[0] === WORKSPACE_PREVIEW_SCOPE_SEGMENT && pathParts[1]?.trim()) {
    return {
      workspaceId: pathParts[1].trim(),
      filePath: pathParts.slice(2).join('/'),
    };
  }

  return {
    workspaceId: null,
    filePath: pathParts.join('/'),
  };
}

function scopedPreviewPrefix(workspaceId: string) {
  return `${WORKSPACE_HTML_PREVIEW_PREFIX}/${WORKSPACE_PREVIEW_SCOPE_SEGMENT}/${encodeURIComponent(workspaceId)}`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path: pathParts } = await context.params;
  const previewPath = parsePreviewPath(pathParts);
  const workspaceResult = await requireRequestWorkspace(request, {
    workspaceId: previewPath.workspaceId,
    permissions: 'canRead',
  });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);
  const filePath = previewPath.filePath;

  try {
    return await createWorkspaceHtmlPreviewResponse({
      filePath,
      fileOptions,
      routePrefix: scopedPreviewPrefix(workspaceResult.workspace.workspaceId),
    });
  } catch {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
