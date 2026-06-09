import { NextRequest, NextResponse } from 'next/server';

import { getPublicMarkdownExport } from '@/app/lib/public-sharing/public-markdown-export';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const result = await getPublicMarkdownExport(decodeURIComponent(token));
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    return new NextResponse(result.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60, must-revalidate',
        'Content-Security-Policy': "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    console.error('[Public Markdown] Export error:', error);

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 413) {
      return NextResponse.json({ success: false, error: 'File is too large to export' }, { status: 413 });
    }

    const message = error instanceof Error ? error.message : 'Failed to export markdown file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
