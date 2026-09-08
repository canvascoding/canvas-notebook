import { NextRequest, NextResponse } from 'next/server';
import { limitPublicExport } from '@/app/lib/public-sharing/public-export-limit';
import { PublicShareReadError } from '@/app/lib/public-sharing/public-share-text';

import {
  assertBrowserExportAvailable,
  isBrowserExportUnavailableError,
} from '@/app/lib/pi/browser/settings-service';
import { generatePdfFromHtml, getPdfRendererClosedMessage, isPdfRendererClosedError } from '@/app/lib/pdf/browser';
import {
  getMarkdownPdfDownloadName,
  getPublicMarkdownExport,
} from '@/app/lib/public-sharing/public-markdown-export';
import { getBrowserExportErrorResponse } from '@/app/lib/exports/browser-export-service';
import { getMarkdownPdfRenderOptions } from '@/app/lib/pdf/markdown-brand';
import { fileContentDisposition } from '@/app/lib/files/content-disposition';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const limited = limitPublicExport(request, 'markdown-pdf');
  if (!limited.ok) return limited.response;
  try {
    const { token } = await context.params;
    const result = await getPublicMarkdownExport(decodeURIComponent(token));
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    await assertBrowserExportAvailable();

    const pdfBuffer = await generatePdfFromHtml(
      result.html,
      getMarkdownPdfRenderOptions(result.brandProfile, result.brandLogoDataUri),
    );

    await result.verifyAccess();

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': fileContentDisposition(getMarkdownPdfDownloadName(result.fileName)),
        'Content-Length': pdfBuffer.length.toString(),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    if (error instanceof PublicShareReadError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.statusCode, headers: { 'Cache-Control': 'no-store' } });
    }
    console.error('[Public Markdown] PDF error:', error);

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

    if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 413) {
      return NextResponse.json({ success: false, error: 'File is too large to export' }, { status: 413 });
    }

    const message = error instanceof Error ? error.message : 'Failed to generate PDF';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
