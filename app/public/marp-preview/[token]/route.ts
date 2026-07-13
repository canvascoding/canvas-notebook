import { NextRequest, NextResponse } from 'next/server';

import { getPublicMarpPreview } from '@/app/lib/public-sharing/public-markdown-export';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
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
        'Cache-Control': 'public, max-age=60, must-revalidate',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    console.error('[Public Marp] Preview error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to render public Marp preview.' },
      { status: 500 },
    );
  }
}
