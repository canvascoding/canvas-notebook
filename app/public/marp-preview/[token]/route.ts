import { NextRequest, NextResponse } from 'next/server';
import { limitPublicExport } from '@/app/lib/public-sharing/public-export-limit';
import { PublicShareReadError } from '@/app/lib/public-sharing/public-share-text';

import { getPublicMarpPreview } from '@/app/lib/public-sharing/public-markdown-export';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const limited = limitPublicExport(request, 'marp-preview');
  if (!limited.ok) return limited.response;
  try {
    const { token } = await context.params;
    const result = await getPublicMarpPreview(decodeURIComponent(token));
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    return new NextResponse(result.html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    if (error instanceof PublicShareReadError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.statusCode, headers: { 'Cache-Control': 'no-store' } });
    }
    console.error('[Public Marp] Preview error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to render public Marp preview.' },
      { status: 500 },
    );
  }
}
