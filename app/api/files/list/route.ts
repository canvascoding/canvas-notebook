import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listDirectory } from '@/app/lib/filesystem/workspace-files';
import { rateLimit } from '@/app/lib/utils/rate-limit';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  isImage: boolean;
}

async function collectFilesRecursive(dirPath: string): Promise<FileEntry[]> {
  try {
    const entries = await listDirectory(dirPath);
    const files: FileEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'directory') {
        // Recursively collect files from subdirectories
        try {
          const subFiles = await collectFilesRecursive(entry.path);
          files.push(...subFiles);
        } catch {
          // Skip directories we can't read
        }
      } else {
        // Check if it's an image
        const extension = entry.path.split('.').pop()?.toLowerCase();
        const isImage = extension ? ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(extension) : false;
        
        files.push({
          name: entry.name,
          path: entry.path,
          type: 'file',
          extension,
          isImage,
        });
      }
    }

    return files;
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'files-list' });
  if (!limited.ok) return limited.response;

  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.toLowerCase() || '';
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    
    // Get all files recursively
    const allFiles = await collectFilesRecursive('.');
    
    // Filter if query provided
    let filteredFiles = allFiles;
    if (query) {
      filteredFiles = allFiles.filter(file => 
        file.name.toLowerCase().includes(query) || 
        file.path.toLowerCase().includes(query)
      );
    }
    
    // Sort: images first, then alphabetically
    filteredFiles.sort((a, b) => {
      if (a.isImage && !b.isImage) return -1;
      if (!a.isImage && b.isImage) return 1;
      return a.path.localeCompare(b.path);
    });
    
    // Apply limit
    const limitedFiles = filteredFiles.slice(0, limit);

    return NextResponse.json({
      success: true,
      files: limitedFiles,
      total: filteredFiles.length,
    });
  } catch (error) {
    console.error('[Files List] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to list files' },
      { status: 500 }
    );
  }
}
