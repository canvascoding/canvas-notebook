import 'server-only';

import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { FileCollaborationPolicyError } from '@/app/lib/files/collaboration-policy';
import { WorkspaceFileRevisionError } from '@/app/lib/files/revision-guard';

import { MobileNotebookError } from './notebook';

export const mobileNotebookResponseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export function mobileNotebookErrorResponse(error: unknown, logContext: string) {
  if (error instanceof MobileNotebookError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.status, headers: mobileNotebookResponseHeaders },
    );
  }
  if (error instanceof WorkspaceFileRevisionError) {
    return NextResponse.json({
      success: false,
      error: error.message,
      code: error.code,
      path: error.path,
      expectedSha256: error.expectedSha256,
      currentSha256: error.currentSha256,
      currentStats: error.currentStats,
    }, { status: error.status, headers: mobileNotebookResponseHeaders });
  }
  if (error instanceof FileCollaborationPolicyError) {
    return NextResponse.json({
      success: false,
      error: error.message,
      code: error.code,
      path: error.path,
      currentRevisionId: error.currentRevisionId,
      baseRevisionId: error.baseRevisionId,
    }, { status: error.status, headers: mobileNotebookResponseHeaders });
  }
  return jsonServerError(logContext, error, 'Notebook request failed');
}
