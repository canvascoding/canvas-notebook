import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createStudioMarkupEdit } from '@/app/lib/integrations/studio-markup-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { resolveMobileStudioOutput } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ generationId: string; outputId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const { generationId, outputId } = await context.params;
    const output = await resolveMobileStudioOutput({ scope: studioRequest.scope, outputId });
    if (output.generationId !== generationId || output.type !== 'image') {
      return NextResponse.json(
        { success: false, error: 'Image output was not found.', code: 'OUTPUT_NOT_FOUND' },
        { status: 404, headers: mobileStudioResponseHeaders },
      );
    }
    const body = await request.json().catch(() => null) as { maskDataUrl?: unknown } | null;
    const edit = await createStudioMarkupEdit({
      sourcePath: output.filePath,
      maskDataUrl: body?.maskDataUrl,
      userId: session.user.id,
      scope: studioRequest.scope,
    });
    return NextResponse.json({ success: true, edit }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio markup failed:');
  }
}
