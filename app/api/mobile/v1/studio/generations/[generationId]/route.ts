import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { getMobileStudioGeneration } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ generationId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { generationId } = await context.params;
    const generation = await getMobileStudioGeneration({ scope: studioRequest.scope, generationId });
    return NextResponse.json({ success: true, generation }, { headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio detail failed:');
  }
}
