import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { readOutputFile } from '@/app/lib/integrations/studio-workspace';
import { getFileStats, writeFile } from '@/app/lib/filesystem/workspace-files';
import { getStudioOutputForUser } from '@/app/lib/integrations/studio-generation-service';
import { requireSessionWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function joinWorkspacePath(dirPath: string, fileName: string) {
  if (dirPath === '.' || dirPath === './') {
    return fileName;
  }

  return `${stripTrailingSlashes(dirPath)}/${fileName}`;
}

async function workspacePathExists(filePath: string, options: WorkspaceFileOperationOptions) {
  try {
    await getFileStats(filePath, options);
    return true;
  } catch {
    return false;
  }
}

async function getAvailableWorkspacePath(
  targetPath: string,
  fileName: string,
  reservedPaths: Set<string>,
  options: WorkspaceFileOperationOptions
) {
  const parsed = path.posix.parse(fileName);
  const extension = parsed.ext;
  const baseName = parsed.name || 'studio-output';
  let candidateName = fileName;
  let index = 1;

  while (true) {
    const candidatePath = joinWorkspacePath(targetPath, candidateName);
    if (!reservedPaths.has(candidatePath) && !(await workspacePathExists(candidatePath, options))) {
      reservedPaths.add(candidatePath);
      return candidatePath;
    }

    candidateName = `${baseName}-${index}${extension}`;
    index += 1;
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { outputId, outputIds, targetPath, targetWorkspaceId } = body;
    const requestedOutputIds = Array.isArray(outputIds)
      ? outputIds
      : outputId
        ? [outputId]
        : [];

    if (requestedOutputIds.length === 0 || requestedOutputIds.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
      return NextResponse.json({ success: false, error: 'outputIds is required' }, { status: 400 });
    }
    if (!targetPath || typeof targetPath !== 'string') {
      return NextResponse.json({ success: false, error: 'targetPath is required' }, { status: 400 });
    }

    const targetWorkspaceResult = await requireSessionWorkspace(session, {
      workspaceId: typeof targetWorkspaceId === 'string' ? targetWorkspaceId : null,
      permissions: 'canWrite',
    });
    if (targetWorkspaceResult.response) return targetWorkspaceResult.response;
    const targetFileOptions = workspaceFileOptions(targetWorkspaceResult.workspace);

    const uniqueOutputIds = [...new Set(requestedOutputIds.map((id: string) => id.trim()))];
    const savedPaths: string[] = [];
    const reservedPaths = new Set<string>();

    for (const id of uniqueOutputIds) {
      // Verify the output is visible to the actor before reading the studio output file.
      const output = await getStudioOutputForUser(id, session.user.id);

      if (!output) {
        return NextResponse.json({ success: false, error: `Output not found: ${id}` }, { status: 404 });
      }

      const buffer = await readOutputFile(output.filePath);
      const fileName = output.filePath.split('/').pop() || `studio-output-${id}`;
      const destinationPath = await getAvailableWorkspacePath(targetPath, fileName, reservedPaths, targetFileOptions);
      await writeFile(destinationPath, buffer, targetFileOptions);
      savedPaths.push(destinationPath);
    }
    await recordAuditEvent({
      organizationId: targetWorkspaceResult.workspace.organizationId,
      workspaceId: targetWorkspaceResult.workspace.workspaceId,
      userId: session.user.id,
      source: 'studio',
      eventType: 'file',
      entityType: 'studio_generation_output',
      entityId: uniqueOutputIds.join(','),
      action: 'studio_output.copy_to_workspace',
      status: 'success',
      summary: `${savedPaths.length} studio output(s) copied to workspace.`,
      metadata: {
        outputIds: uniqueOutputIds,
        targetPath,
        savedPaths,
        targetWorkspaceId: targetWorkspaceResult.workspace.workspaceId,
        targetWorkspaceType: targetWorkspaceResult.workspace.workspaceType,
      },
    });

    return NextResponse.json({
      success: true,
      paths: savedPaths,
      savedCount: savedPaths.length,
      targetWorkspaceId: targetWorkspaceResult.workspace.workspaceId,
    });
  } catch (error) {
    console.error('[Studio Save to Workspace] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to save output to workspace' }, { status: 500 });
  }
}
