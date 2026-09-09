import { NextRequest, NextResponse } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { createWorkspaceUploadDirectories } from '@/app/lib/filesystem/upload-directories';
import { workspaceUploadErrorResponse } from '@/app/lib/files/workspace-upload-responses';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const access = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (access.response) return access.response;
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'workspace-upload-directories' });
  if (!limited.ok) return limited.response;
  try {
    const body = await request.json() as { targetDir?: unknown; directories?: unknown };
    if (!Array.isArray(body.directories) || !body.directories.every((path) => typeof path === 'string')) {
      return NextResponse.json({ success: false, error: 'A list of folder paths is required.' }, { status: 400 });
    }
    const result = await createWorkspaceUploadDirectories(access.workspace, typeof body.targetDir === 'string' ? body.targetDir : '.', body.directories);
    await recordAuditEvent({ organizationId: access.workspace.organizationId, workspaceId: access.workspace.workspaceId, userId: access.session.user.id,
      source: 'files', eventType: 'file', entityType: 'workspace_path', entityId: typeof body.targetDir === 'string' ? body.targetDir : '.',
      action: 'file.directory.upload', status: result.failed.length ? 'failure' : 'success', summary: `Imported ${result.completed.length} empty folders.`,
      metadata: { completed: result.completed.map((entry) => entry.committed.targetPath), failed: result.failed } });
    return NextResponse.json({ success: true, ...result });
  } catch (error) { return workspaceUploadErrorResponse(error, '[API] Failed to upload directories:'); }
}
