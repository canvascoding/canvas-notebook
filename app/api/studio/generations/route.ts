import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listStudioGenerations } from '@/app/lib/integrations/studio-generation-service';

const DEFAULT_LIMIT = 48;
const MAX_LIMIT = 100;

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limit = Math.min(parsePositiveInt(request.nextUrl.searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);
    const offset = parsePositiveInt(request.nextUrl.searchParams.get('offset'), 0);
    const result = await listStudioGenerations(session.user.id, { limit, offset });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[Studio Generations] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to list generations' }, { status: 500 });
  }
}
