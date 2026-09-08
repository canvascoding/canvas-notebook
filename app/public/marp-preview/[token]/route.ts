import { NextRequest, NextResponse } from 'next/server';

import { getPublicMarpPreview } from '@/app/lib/public-sharing/public-markdown-export';
import { publicRateLimit, publicResourceRateLimit } from '@/app/lib/security/public-rate-limit';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const limited = await publicRateLimit({ keyPrefix: 'public-marp-preview', limit: 30, globalLimit: 600, windowMs: 60_000 });
  if (!limited.ok) return limited.response;
  try {
    const { token } = await context.params;
    const targetLimit = await publicResourceRateLimit({ keyPrefix: 'public-marp-preview', limit: 120, windowMs: 60_000 }, token);
    if (!targetLimit.ok) return targetLimit.response;
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
