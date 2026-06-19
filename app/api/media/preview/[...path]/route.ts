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
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  const { path: pathParts } = await context.params;
  const filePath = pathParts.join('/');

  try {
    if (!isHtmlFile(filePath)) {
      return await streamPreviewAsset(filePath, fileOptions);
    }

    const html = (await readFile(filePath, fileOptions)).toString('utf-8');
    const document = createHtmlPreviewDocument(html, filePath, WORKSPACE_HTML_PREVIEW_PREFIX);
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
