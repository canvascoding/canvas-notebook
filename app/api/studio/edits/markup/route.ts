import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createStudioMarkupEdit } from '@/app/lib/integrations/studio-markup-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  const body = await request.json().catch(() => null) as { sourcePath?: unknown; maskDataUrl?: unknown } | null;
  try {
    const edit = await createStudioMarkupEdit({
      sourcePath: typeof body?.sourcePath === 'string' ? body.sourcePath : '',
      maskDataUrl: body?.maskDataUrl,
      userId: session.user.id,
      scope: studioRequest.scope,
    });
    return NextResponse.json({
      success: true,
      edit: {
        ...edit,
        mediaUrl: toMediaUrl(edit.path, { workspaceId: studioRequest.scope.workspaceId }),
        previewUrl: toPreviewUrl(edit.path, 960, { workspaceId: studioRequest.scope.workspaceId }),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create markup image';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
