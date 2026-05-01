import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { auth } from '@/app/lib/auth';

const DATA = process.env.DATA || '/data';
const SKILLS_DIR = path.join(DATA, 'skills');

function sanitizeFilePath(filePath: string): string {
  let clean = filePath;
  clean = clean.replace(/\.\./g, '');
  clean = clean.replace(/\/\/+/g, '/');
  clean = clean.replace(/^\//, '');
  clean = clean.replace(/\/$/, '');
  return clean;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json({ success: false, error: 'path parameter is required' }, { status: 400 });
    }

    const sanitizedPath = sanitizeFilePath(filePath);
    const fullPath = path.join(SKILLS_DIR, sanitizedPath);
    const resolvedPath = path.resolve(fullPath);
    const resolvedSkillsDir = path.resolve(SKILLS_DIR);

    if (!resolvedPath.startsWith(resolvedSkillsDir)) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
    }

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return NextResponse.json({ success: false, error: 'Path is a directory, not a file' }, { status: 400 });
    }

    const content = await fs.readFile(resolvedPath, 'utf-8');

    return NextResponse.json({
      success: true,
      content,
      name: path.basename(resolvedPath),
      size: stat.size,
      modified: stat.mtimeMs,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
    console.error('[Skills File API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read file' },
      { status: 500 }
    );
  }
}