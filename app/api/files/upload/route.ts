import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { writeFile, createDirectory } from '@/app/lib/ssh/sftp-client';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 1000, // Increased from 10 to allow folder uploads
      windowMs: 60_000,
      keyPrefix: 'files-upload',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const targetDir = formData.get('path')?.toString() || '.';

    if (!files || files.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Files are required' },
        { status: 400 }
      );
    }

    for (const file of files) {
      const relativePath = file.name; // FormData gives us the relative path as the filename
      const buffer = Buffer.from(await file.arrayBuffer());
      
      const targetPath = path.posix.join(targetDir, relativePath);
      
      // Ensure parent directory exists
      const parentDir = path.posix.dirname(targetPath);
      if (parentDir !== '.' && parentDir !== targetDir && parentDir !== '/') {
          await createDirectory(parentDir);
      }

      await writeFile(targetPath, buffer);
    }

    clearFileTreeCache();

    return NextResponse.json({ success: true, count: files.length });
  } catch (error) {
    console.error('[API] File upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
