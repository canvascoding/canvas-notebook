import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { loadMarkdownLinkPreview, MarkdownLinkPreviewError } from '@/app/lib/markdown/link-preview';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'markdown-link-preview' });
  if (!limited.ok) return limited.response;

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url')?.trim() || '';

  if (!url || url.length > 2_048) {
    return NextResponse.json({ success: false, error: 'Enter a valid URL' }, { status: 400 });
  }

  try {
    const preview = await loadMarkdownLinkPreview(url);
    return NextResponse.json(
      { success: true, data: preview },
      {
        headers: {
          'Cache-Control': 'private, max-age=300',
        },
      }
    );
  } catch (error) {
    if (error instanceof MarkdownLinkPreviewError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }

    console.error('[Markdown Link Preview] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load link preview' }, { status: 500 });
  }
}
