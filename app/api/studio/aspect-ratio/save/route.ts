import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { saveAspectRatioEdit, type AspectRatioSaveRequest } from '@/app/lib/integrations/studio-aspect-ratio-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'studio-aspect-ratio-save',
  });
  if (!limited.ok) return limited.response;

  let body: AspectRatioSaveRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const result = await saveAspectRatioEdit(body);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Save failed';
    const status = /required|only local|unsupported|previewPath|confirmation/i.test(message) ? 400 : 500;
    if (status >= 500) {
      console.error('[Studio Aspect Ratio Save] Error:', error);
    }
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
