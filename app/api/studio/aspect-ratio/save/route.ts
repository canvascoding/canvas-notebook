import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { saveAspectRatioEdit, type AspectRatioSaveRequest } from '@/app/lib/integrations/studio-aspect-ratio-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

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
    const workspaceOptions = body.action === 'copy_workspace'
      ? await requireSessionWorkspace(session, {
          workspaceId: typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId : null,
          permissions: 'canWrite',
        })
      : null;
    if (workspaceOptions?.response) return workspaceOptions.response;

    const result = await saveAspectRatioEdit(
      body,
      session.user.id,
      workspaceOptions?.workspace ? workspaceFileOptions(workspaceOptions.workspace) : undefined
    );
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
