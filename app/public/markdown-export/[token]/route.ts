import { NextRequest, NextResponse } from 'next/server';
import { PublicShareReadError } from '@/app/lib/public-sharing/public-share-text';
import { publicRateLimit, publicResourceRateLimit } from '@/app/lib/security/public-rate-limit';

import { getBrowserExportErrorResponse } from '@/app/lib/exports/browser-export-service';
import { getPublicMarkdownExport } from '@/app/lib/public-sharing/public-markdown-export';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const limited = await publicRateLimit({ keyPrefix: 'public-markdown-export', limit: 30, globalLimit: 600, windowMs: 60_000 });
  if (!limited.ok) return limited.response;
  try {
    const { token } = await context.params;
    const targetLimit = await publicResourceRateLimit({ keyPrefix: 'public-markdown-export', limit: 120, windowMs: 60_000 }, token);
    if (!targetLimit.ok) return targetLimit.response;
    const result = await getPublicMarkdownExport(decodeURIComponent(token));
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    await result.verifyAccess();

    return new NextResponse(result.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    if (error instanceof PublicShareReadError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.statusCode, headers: { 'Cache-Control': 'no-store' } });
    }
    console.error('[Public Markdown] Export error:', error);

    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }

    const browserExportError = getBrowserExportErrorResponse(error);
    if (browserExportError) {
      return NextResponse.json(browserExportError.body, { status: browserExportError.status });
    }

    if (error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 413) {
      return NextResponse.json({ success: false, error: 'File is too large to export' }, { status: 413 });
    }

    const message = error instanceof Error ? error.message : 'Failed to export markdown file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
