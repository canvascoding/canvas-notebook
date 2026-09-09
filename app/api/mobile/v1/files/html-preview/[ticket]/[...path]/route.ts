import { NextResponse } from 'next/server';

import { htmlPreviewTicketPath, resolveHtmlPreviewTicket } from '@/app/lib/html-preview-ticket';
import { htmlPreviewUrl } from '@/app/lib/html-preview-origin';
import { normalizeMobileFilePath } from '@/app/lib/mobile/files';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    const filePath = normalizeMobileFilePath(pathParts.join('/'), false);
    const identity = await resolveHtmlPreviewTicket(ticket,filePath);
    if (!identity) return unavailable();
    return NextResponse.redirect(htmlPreviewUrl(htmlPreviewTicketPath(ticket,filePath)),{
      status:302,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'},
    });
  } catch {
    return unavailable();
  }
}
