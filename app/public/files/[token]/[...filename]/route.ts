import { NextRequest, NextResponse } from 'next/server';

import { publicShareFileResponse } from '@/app/lib/public-sharing/public-file-response';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';

function publicExcalidrawPreviewPath(token: string, fileName: string): string {
  return `/public/view/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

async function handlePublicFileRequest(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> },
  method: 'GET' | 'HEAD',
) {
  const { token } = await context.params;
  const decodedToken = decodeURIComponent(token);

  if (method === 'GET') {
    const previewCheck = await resolvePublicShareToken(decodedToken, { recordAccess: false });
    if (previewCheck.ok && isExcalidrawFilePath(previewCheck.workspacePath)) {
      return NextResponse.redirect(new URL(
        publicExcalidrawPreviewPath(decodedToken, previewCheck.share.fileName),
        request.url
      ));
    }

    if (!previewCheck.ok) {
      return publicShareFileResponse(request, previewCheck, method);
    }
  }

  const resolved = await resolvePublicShareToken(decodedToken);
  return publicShareFileResponse(request, resolved, method);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> }
) {
  return handlePublicFileRequest(request, context, 'GET');
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> }
) {
  return handlePublicFileRequest(request, context, 'HEAD');
}
