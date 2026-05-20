import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getAspectRatioModelOptions } from '@/app/lib/integrations/studio-aspect-ratio-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'studio-aspect-ratio-models',
  });
  if (!limited.ok) return limited.response;

  return NextResponse.json({
    success: true,
    providers: getAspectRatioModelOptions(),
  });
}
