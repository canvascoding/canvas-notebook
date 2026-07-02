import { NextRequest, NextResponse } from 'next/server';
import { getFileStats, createReadStream, readFile } from '@/app/lib/filesystem/workspace-files';
import { Readable } from 'stream';
import {
  createHtmlPreviewDocument,
  getHtmlPreviewAssetContentType,
  HTML_PREVIEW_ASSET_CSP,
  HTML_PREVIEW_CSP,
  isHtmlFile,
} from '@/app/lib/html-preview';
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

async function streamPreviewAsset(filePath: string, fileOptions: ReturnType<typeof workspaceFileOptions>) {
  const stats = await getFileStats(filePath, fileOptions);
  const { stream } = await createReadStream(filePath, undefined, fileOptions);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': getHtmlPreviewAssetContentType(filePath),
      'Content-Length': stats.size.toString(),
      'Content-Security-Policy': HTML_PREVIEW_ASSET_CSP,
      'X-Content-Type-Options': 'nosniff',
    },
  });
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
    if (!isHtmlFile(filePath)) {
      return await streamPreviewAsset(filePath, fileOptions);
    }

    const html = (await readFile(filePath, fileOptions)).toString('utf-8');
    const document = createHtmlPreviewDocument(
      html,
      filePath,
      scopedPreviewPrefix(workspaceResult.workspace.workspaceId),
    );
    const body = Buffer.from(document, 'utf-8');
    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length.toString(),
      'Content-Security-Policy': HTML_PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
    });

    return new NextResponse(body, { status: 200, headers });
  } catch {
    return NextResponse.json({ success: false, error: 'File not found or unreadable' }, { status: 404 });
  }
}
