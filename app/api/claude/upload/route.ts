import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { auth } from '@/app/lib/auth';
import { getWorkspacePath, ensureWorkspaceExists } from '@/app/lib/utils/workspace-manager';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const sessionId = formData.get('sessionId')?.toString() || 'default-session';

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    // Validate file type
    const validTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      return NextResponse.json({ success: false, error: 'Invalid file type. Only PNG, JPG, and WebP are allowed.' }, { status: 400 });
    }

    const workspacePath = getWorkspacePath(sessionId);
    const uploadsDir = path.join(workspacePath, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });

    const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(uploadsDir, fileName);
    const buffer = Buffer.from(await file.arrayBuffer());

    await fs.writeFile(filePath, buffer);

    // Return the relative path for Claude to use
    const relativePath = path.join('uploads', fileName);

    return NextResponse.json({
      success: true,
      path: relativePath,
      name: file.name
    });
  } catch (error) {
    console.error('[API] Claude upload error:', error);
    return NextResponse.json({ success: false, error: 'Failed to upload image' }, { status: 500 });
  }
}
