import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { generatePdfFromUrl } from '@/app/lib/pdf/browser';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import path from 'path';

const PDF_TIMEOUT_MS = 30_000;

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

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

    await getFileStats(filePath);

    const origin = new URL(request.url).origin;
    const fileName = path.basename(filePath, ext);
    const cookie = request.headers.get('cookie');
    const headers = cookie ? { cookie } : undefined;

    const pdfBuffer = await Promise.race([
      generatePdfFromUrl(`${origin}${toMediaUrl(filePath)}`, headers),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('PDF_TIMEOUT')), PDF_TIMEOUT_MS)
      ),
    ]);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${fileName}.pdf"`,
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

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const message = error instanceof Error ? error.message : 'Failed to generate PDF';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
