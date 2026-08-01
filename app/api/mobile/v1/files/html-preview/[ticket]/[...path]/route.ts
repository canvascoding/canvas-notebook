import { NextResponse } from 'next/server';

import { createWorkspaceHtmlPreviewResponse } from '@/app/lib/html-preview-response';
import { resolveMobileHtmlPreviewTicket } from '@/app/lib/mobile/html-preview-ticket';
import { normalizeMobileFilePath } from '@/app/lib/mobile/files';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MOBILE_HTML_PREVIEW_PREFIX = '/api/mobile/v1/files/html-preview';

function unavailable() {
  return new NextResponse(null, {
    status: 404,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticket: string; path: string[] }> },
) {
  try {
    const { ticket, path: pathParts } = await context.params;
    const identity = resolveMobileHtmlPreviewTicket(ticket);
    if (!identity?.workspace.permissions.canRead) return unavailable();
    const filePath = normalizeMobileFilePath(pathParts.join('/'), false);
    return await createWorkspaceHtmlPreviewResponse({
      filePath,
      fileOptions: workspaceFileOptions(identity.workspace),
      routePrefix: `${MOBILE_HTML_PREVIEW_PREFIX}/${encodeURIComponent(ticket)}`,
    });
  } catch {
    return unavailable();
  }
}
