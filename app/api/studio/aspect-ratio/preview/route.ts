import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createAspectRatioPreview, type AspectRatioPreviewRequest } from '@/app/lib/integrations/studio-aspect-ratio-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: 'studio-aspect-ratio-preview',
  });
  if (!limited.ok) return limited.response;

  let body: AspectRatioPreviewRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const preview = await createAspectRatioPreview(body, { userId: session.user.id });
    return NextResponse.json({ success: true, preview }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview failed';
    const status = /required|unsupported|invalid|outside|freeform|size|provider|ratio/i.test(message) ? 400 : 500;
    if (status >= 500) {
      console.error('[Studio Aspect Ratio Preview] Error:', error);
    }
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
