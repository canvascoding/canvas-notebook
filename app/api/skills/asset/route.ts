import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { getSkillsDir } from '@/app/lib/skills/canvas-skill-manifest';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sanitizeAssetPath(filePath: string): string {
  return filePath
    .replace(/\0/g, '')
    .replace(/\.\./g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
}

async function directoryExists(targetPath: string): Promise<boolean> {
  return fs.stat(targetPath).then((stat) => stat.isDirectory()).catch(() => false);
}

async function resolveReadableSkillsDir(userId: string): Promise<string> {
  const scopedDir = getSkillsDir({ userId });
  if (!(await directoryExists(scopedDir))) {
    return getSkillsDir();
  }
  return scopedDir;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const requestedPath = request.nextUrl.searchParams.get('path');
  if (!requestedPath) {
    return NextResponse.json({ success: false, error: 'path parameter is required' }, { status: 400 });
  }

  const sanitizedPath = sanitizeAssetPath(requestedPath);
  const ext = path.extname(sanitizedPath).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Only image assets are supported' }, { status: 400 });
  }

  const skillsDir = await resolveReadableSkillsDir(session.user.id);
  const fullPath = path.join(skillsDir, sanitizedPath);
  const resolvedPath = path.resolve(/*turbopackIgnore: true*/ fullPath);
  const resolvedSkillsDir = path.resolve(/*turbopackIgnore: true*/ skillsDir);
  if (!resolvedPath.startsWith(`${resolvedSkillsDir}${path.sep}`)) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return NextResponse.json({ success: false, error: 'Path is not a file' }, { status: 400 });
    }

    const bytes = await fs.readFile(resolvedPath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, max-age=3600',
        'Content-Type': contentType,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    console.error('[Skills Asset API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to read asset' }, { status: 500 });
  }
}
