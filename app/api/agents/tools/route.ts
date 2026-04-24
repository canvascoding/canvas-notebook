import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { getPiToolMetadata } from '@/app/lib/pi/tool-registry';

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    session,
    response: null,
  };
}

export async function GET(request: NextRequest) {
  const { session, response } = await requireSession(request);
  if (response || !session) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-tools-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const tools = getPiToolMetadata();
    return NextResponse.json({
      success: true,
      data: { tools },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load tool metadata.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}