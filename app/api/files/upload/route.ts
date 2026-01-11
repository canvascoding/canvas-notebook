import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { writeFile } from '@/app/lib/ssh/sftp-client';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 10,
      windowMs: 60_000,
      keyPrefix: 'files-upload',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const targetDir = formData.get('path')?.toString() || '.';

    if (!file || typeof file !== 'object' || !('arrayBuffer' in file)) {
      return NextResponse.json(
        { success: false, error: 'File is required' },
        { status: 400 }
      );
    }

    const safeFile = file as { arrayBuffer: () => Promise<ArrayBuffer>; name?: string };
    const arrayBuffer = await safeFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileName = safeFile.name || 'upload.bin';
    const targetPath = path.posix.join(targetDir, fileName);

    await writeFile(targetPath, buffer);
    clearFileTreeCache();

    return NextResponse.json({ success: true, path: targetPath });
  } catch (error) {
    console.error('[API] File upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
