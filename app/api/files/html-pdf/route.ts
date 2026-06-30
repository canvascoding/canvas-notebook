import { NextRequest, NextResponse } from 'next/server';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import {
  assertBrowserExportAvailable,
  isBrowserExportUnavailableError,
} from '@/app/lib/pi/browser/settings-service';
import { generatePdfFromUrl } from '@/app/lib/pdf/browser';
import { toHtmlPreviewUrl } from '@/app/lib/utils/media-url';
import path from 'path';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

const PDF_TIMEOUT_MS = 30_000;

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

    const pdfBuffer = await Promise.race([
      generatePdfFromUrl(`${origin}${toHtmlPreviewUrl(filePath)}`, headers),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PDF_TIMEOUT')), PDF_TIMEOUT_MS)
      ),
    ]);

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

    if (isBrowserExportUnavailableError(error)) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to generate PDF';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
