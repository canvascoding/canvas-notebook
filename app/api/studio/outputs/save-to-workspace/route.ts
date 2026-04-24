import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { auth } from '@/app/lib/auth';
import { readOutputFile } from '@/app/lib/integrations/studio-workspace';
import { getFileStats, writeFile } from '@/app/lib/filesystem/workspace-files';
import { getStudioOutputForUser } from '@/app/lib/integrations/studio-generation-service';

function joinWorkspacePath(dirPath: string, fileName: string) {
  if (dirPath === '.' || dirPath === './') {
    return fileName;
  }

  return `${dirPath.replace(/\/+$/, '')}/${fileName}`;
}

async function workspacePathExists(filePath: string) {
  try {
    await getFileStats(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getAvailableWorkspacePath(targetPath: string, fileName: string, reservedPaths: Set<string>) {
  const parsed = path.posix.parse(fileName);
  const extension = parsed.ext;
  const baseName = parsed.name || 'studio-output';
  let candidateName = fileName;
  let index = 1;

  while (true) {
    const candidatePath = joinWorkspacePath(targetPath, candidateName);
    if (!reservedPaths.has(candidatePath) && !(await workspacePathExists(candidatePath))) {
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
    const { outputId, outputIds, targetPath } = body;
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

    const uniqueOutputIds = [...new Set(requestedOutputIds.map((id: string) => id.trim()))];
    const savedPaths: string[] = [];
    const reservedPaths = new Set<string>();

    for (const id of uniqueOutputIds) {
      // Verify output belongs to user before reading the studio output file.
      const output = await getStudioOutputForUser(id, session.user.id);

      if (!output) {
        return NextResponse.json({ success: false, error: `Output not found: ${id}` }, { status: 404 });
      }

      const buffer = await readOutputFile(output.filePath);
      const fileName = output.filePath.split('/').pop() || `studio-output-${id}`;
      const destinationPath = await getAvailableWorkspacePath(targetPath, fileName, reservedPaths);
      await writeFile(destinationPath, buffer);
      savedPaths.push(destinationPath);
    }

    return NextResponse.json({ success: true, paths: savedPaths, savedCount: savedPaths.length });
  } catch (error) {
    console.error('[Studio Save to Workspace] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to save output to workspace' }, { status: 500 });
  }
}
