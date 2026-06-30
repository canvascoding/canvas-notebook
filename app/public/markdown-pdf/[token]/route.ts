import { NextRequest, NextResponse } from 'next/server';

import {
  assertBrowserExportAvailable,
  isBrowserExportUnavailableError,
} from '@/app/lib/pi/browser/settings-service';
import { generatePdfFromHtml } from '@/app/lib/pdf/browser';
import {
  getMarkdownPdfDownloadName,
  getPublicMarkdownExport,
} from '@/app/lib/public-sharing/public-markdown-export';

const PDF_TIMEOUT_MS = 30_000;

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const result = await getPublicMarkdownExport(decodeURIComponent(token));
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    await assertBrowserExportAvailable();

    const pdfBuffer = await Promise.race([
      generatePdfFromHtml(result.html),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PDF_TIMEOUT')), PDF_TIMEOUT_MS)
      ),
    ]);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${getMarkdownPdfDownloadName(result.fileName)}"`,
        'Content-Length': pdfBuffer.length.toString(),
        'Cache-Control': 'private, no-cache',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    console.error('[Public Markdown] PDF error:', error);

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

    if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 413) {
      return NextResponse.json({ success: false, error: 'File is too large to export' }, { status: 413 });
    }

    const message = error instanceof Error ? error.message : 'Failed to generate PDF';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
