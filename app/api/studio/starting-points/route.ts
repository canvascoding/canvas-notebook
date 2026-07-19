import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { STUDIO_STARTING_POINTS } from '@/app/lib/integrations/studio-starting-points';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    success: true,
    startingPoints: STUDIO_STARTING_POINTS.map((point) => ({ ...point, presetId: null })),
  });
}
