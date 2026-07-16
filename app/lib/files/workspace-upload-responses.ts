import 'server-only';

import { NextResponse } from 'next/server';

import { FileCollaborationPolicyError } from '@/app/lib/files/collaboration-policy';
import { WorkspaceUploadServiceError } from '@/app/lib/files/workspace-upload-service';

export function workspaceUploadErrorResponse(error: unknown, scope: string): NextResponse {
  if (error instanceof WorkspaceUploadServiceError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code, ...error.details },
      { status: error.status },
    );
  }
  if (error instanceof FileCollaborationPolicyError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        code: error.code,
        path: error.path,
        currentRevisionId: error.currentRevisionId,
        baseRevisionId: error.baseRevisionId,
        activeLock: error.activeLock,
      },
      { status: error.status },
    );
  }
  if (error && typeof error === 'object' && 'status' in error && 'code' in error) {
    const status = Number(error.status);
    const code = String(error.code);
    const message = error instanceof Error ? error.message : 'Upload request is invalid.';
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return NextResponse.json({ success: false, error: message, code }, { status });
    }
  }

  console.error(scope, error);
  return NextResponse.json(
    { success: false, error: 'The upload could not be processed.', code: 'UPLOAD_INTERNAL_ERROR' },
    { status: 500 },
  );
}
