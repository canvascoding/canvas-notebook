import { NextRequest, NextResponse } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import {
  assertBrowserExportAvailable,
  isBrowserExportUnavailableError,
} from '@/app/lib/pi/browser/settings-service';
import { generatePdfFromUrl, getPdfRendererClosedMessage, isPdfRendererClosedError } from '@/app/lib/pdf/browser';
import { getBrowserExportErrorResponse } from '@/app/lib/exports/browser-export-service';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import path from 'path';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

function getInternalRenderOrigin(requestUrl: string) {
  const url = new URL(requestUrl);
  const rawPort = url.port || process.env.PORT || '3000';
  const port = /^\d{1,5}$/.test(rawPort) && Number(rawPort) > 0 && Number(rawPort) <= 65535
    ? rawPort
    : '3000';

  return `http://127.0.0.1:${port}`;
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const body = await request.json().catch(() => null);
    const filePath = body?.path;

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Path is required' },
        { status: 400 }
      );
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!['.html', '.htm'].includes(ext)) {
      return NextResponse.json(
        { success: false, error: 'File must be an HTML file (.html, .htm)' },
        { status: 400 }
      );
    }

    await getFileStats(filePath, fileOptions);
    await assertBrowserExportAvailable();

    const origin = getInternalRenderOrigin(request.url);
    const fileName = path.basename(filePath, ext);
    const cookie = request.headers.get('cookie');
    const headers = cookie ? { cookie } : undefined;

    const pdfBuffer = await generatePdfFromUrl(
      `${origin}${toHtmlPreviewUrl(filePath, { workspaceId: workspaceResult.workspace.workspaceId })}`,
      headers,
    );

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}.pdf"`,
        'Content-Length': pdfBuffer.length.toString(),
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (error) {
    console.error('[API] HTML PDF error:', error);

    if (error instanceof Error && error.message === 'PDF_TIMEOUT') {
      return NextResponse.json(
        { success: false, error: 'PDF generation timed out. Try again.' },
        { status: 504 }
      );
    }

    const browserExportError = getBrowserExportErrorResponse(error);
    if (browserExportError) {
      return NextResponse.json(browserExportError.body, { status: browserExportError.status });
    }

    if (isBrowserExportUnavailableError(error)) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }

    if (isPdfRendererClosedError(error)) {
      return NextResponse.json(
        { success: false, code: 'PDF_RENDERER_CLOSED', error: getPdfRendererClosedMessage() },
        { status: 503 }
      );
    }

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to generate PDF';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
