import { NextRequest, NextResponse } from 'next/server';

import { workspaceUploadErrorResponse } from '@/app/lib/files/workspace-upload-responses';
import {
  createWorkspaceUploadSession,
  publicWorkspaceUploadSession,
  workspaceUploadLimits,
} from '@/app/lib/files/workspace-upload-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'workspace-upload-create',
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json() as {
      targetDir?: unknown;
      files?: unknown;
    };
    const requestedFiles = Array.isArray(payload.files) ? payload.files : [];
    const files = requestedFiles.map((candidate) => {
      const record = candidate && typeof candidate === 'object'
        ? candidate as Record<string, unknown>
        : {};
      return {
        path: typeof record.path === 'string' ? record.path : '',
        size: typeof record.size === 'number' ? record.size : Number.NaN,
        mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      };
    });
    const upload = await createWorkspaceUploadSession({
      userId: workspaceResult.session.user.id,
      workspace: workspaceResult.workspace,
      targetDir: typeof payload.targetDir === 'string' ? payload.targetDir : '.',
      files,
    });

    return NextResponse.json(
      {
        success: true,
        upload: publicWorkspaceUploadSession(upload),
        limits: workspaceUploadLimits(),
      },
      { status: 201 },
    );
  } catch (error) {
    return workspaceUploadErrorResponse(error, '[API] Failed to create workspace upload:');
  }
}
