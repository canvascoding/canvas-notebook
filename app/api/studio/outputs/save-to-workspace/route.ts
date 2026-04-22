import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readOutputFile } from '@/app/lib/integrations/studio-workspace';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { getStudioOutputForUser } from '@/app/lib/integrations/studio-generation-service';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { outputId, targetPath } = body;

    if (!outputId || typeof outputId !== 'string') {
      return NextResponse.json({ success: false, error: 'outputId is required' }, { status: 400 });
    }
    if (!targetPath || typeof targetPath !== 'string') {
      return NextResponse.json({ success: false, error: 'targetPath is required' }, { status: 400 });
    }

    // Verify output belongs to user
    const output = await getStudioOutputForUser(outputId, session.user.id);

    if (!output) {
      return NextResponse.json({ success: false, error: 'Output not found' }, { status: 404 });
    }

    const buffer = await readOutputFile(output.filePath);

    // Normalize target path
    let safeTargetPath = targetPath;
    if (!safeTargetPath.endsWith('/')) {
      safeTargetPath += '/';
    }
    const fileName = output.filePath.split('/').pop() || `studio-output-${outputId}`;
    const destinationPath = `${safeTargetPath}${fileName}`;

    await writeFile(destinationPath, buffer);

    return NextResponse.json({ success: true, path: destinationPath });
  } catch (error) {
    console.error('[Studio Save to Workspace] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to save output to workspace' }, { status: 500 });
  }
}
