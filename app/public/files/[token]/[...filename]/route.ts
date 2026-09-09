import { NextRequest, NextResponse } from 'next/server';

import { publicShareFileResponse, publicShareNotFoundResponse } from '@/app/lib/public-sharing/public-file-response';
import { resolvePublicHtmlSiteAssetWorkspacePath } from '@/app/lib/public-sharing/public-share-security';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { resolvePublicShareToken } from '@/app/lib/public-sharing/public-file-shares';
import { buildPublicRequestUrl } from '@/app/lib/utils/request-origin';

function publicPreviewPath(token: string, fileName: string, shortCode?: string | null): string {
  if (shortCode) return `/p/${encodeURIComponent(shortCode)}`;
  return `/public/view/${encodeURIComponent(token)}/${encodeURIComponent(fileName)}`;
}

function wantsAttachmentDownload(request: NextRequest): boolean {
  return request.nextUrl.searchParams.get('download') === '1';
}

function isBrowserDocumentNavigation(request: NextRequest): boolean {
  const fetchDest = request.headers.get('sec-fetch-dest');
  if (fetchDest) return fetchDest === 'document';

  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

async function handlePublicFileRequest(
  request: NextRequest,
  context: { params: Promise<{ token: string; filename: string[] }> },
  method: 'GET' | 'HEAD',
) {
  const { token, filename } = await context.params;
  let decodedToken: string;
  try {
    decodedToken = decodeURIComponent(token);
  } catch {
    return publicShareNotFoundResponse();
  }

  if (method === 'GET') {
    const previewCheck = await resolvePublicShareToken(decodedToken, { recordAccess: false });
    if (
      previewCheck.ok
      && resolvePublicHtmlSiteAssetWorkspacePath(previewCheck.workspacePath, filename) === previewCheck.workspacePath
      && !wantsAttachmentDownload(request)
      && (isExcalidrawFilePath(previewCheck.workspacePath) || isBrowserDocumentNavigation(request))
    ) {
      const response = NextResponse.redirect(buildPublicRequestUrl(
        request,
        publicPreviewPath(decodedToken, previewCheck.share.fileName, previewCheck.share.shortCode)
      ));
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }

    if (!previewCheck.ok) {
      return publicShareFileResponse(request, previewCheck, method, { requestedPathParts: filename });
    }
  }

  const resolved = await resolvePublicShareToken(decodedToken, { recordAccess: method !== 'HEAD' });
  return publicShareFileResponse(request, resolved, method, { requestedPathParts: filename });
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
