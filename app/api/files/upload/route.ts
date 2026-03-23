import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { writeFile, createDirectory } from '@/app/lib/filesystem/workspace-files';
import { clearFileTreeCache } from '@/app/lib/utils/file-tree-cache';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { auth } from '@/app/lib/auth';

// Upload limits
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB per file
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500MB total per request
const MAX_FILES_PER_REQUEST = 100;

// Valid filename pattern - only allow safe characters
const VALID_FILENAME_REGEX = /^[a-zA-Z0-9._\-\s\/\(\)]+$/;
const INVALID_PATH_PATTERNS = ['..', '~', '//', '\\\\', ':', '*', '?', '"', '<', '>', '|'];

function isValidFilename(filename: string): boolean {
  // Check for path traversal attempts
  if (INVALID_PATH_PATTERNS.some(pattern => filename.includes(pattern))) {
    return false;
  }
  // Must match valid characters
  return VALID_FILENAME_REGEX.test(filename);
}

function sanitizeFilename(filename: string): string {
  // Remove any path components, keep only the filename
  return path.posix.basename(filename.replace(/\\/g, '/'));
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 50, // Reduced from 1000 for security
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

    // Check file count limit
    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MAX_FILES_PER_REQUEST} files per upload` },
        { status: 400 }
      );
    }

    // Calculate total size
    let totalSize = 0;
    for (const file of files) {
      totalSize += file.size;
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { success: false, error: `File "${file.name}" exceeds maximum size of 100MB` },
          { status: 413 }
        );
      }
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      return NextResponse.json(
        { success: false, error: `Total upload size exceeds maximum of 500MB` },
        { status: 413 }
      );
    }

    if (targetDir && targetDir !== '.') {
      await createDirectory(targetDir);
    }

    const uploadedFiles: string[] = [];

    for (const file of files) {
      // Sanitize and validate filename
      const sanitizedName = sanitizeFilename(file.name);
      
      if (!isValidFilename(sanitizedName)) {
        return NextResponse.json(
          { success: false, error: `Invalid filename: "${file.name}". Only alphanumeric characters, dots, dashes, underscores, spaces, and parentheses are allowed.` },
          { status: 400 }
        );
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      
      const targetPath = path.posix.join(targetDir, sanitizedName);
      
      // Ensure parent directory exists
      const parentDir = path.posix.dirname(targetPath);
      if (parentDir !== '.' && parentDir !== targetDir && parentDir !== '/') {
          await createDirectory(parentDir);
      }

      await writeFile(targetPath, buffer);
      uploadedFiles.push(sanitizedName);
    }

    clearFileTreeCache();

    return NextResponse.json({ success: true, count: files.length, files: uploadedFiles });
  } catch (error) {
    console.error('[API] File upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload file';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
