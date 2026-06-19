import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

const IGNORED_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.cache']);

async function calculateStats(dirPath: string): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await calculateStats(entryPath);
        fileCount += sub.fileCount;
        totalSize += sub.totalSize;
      } else {
        try {
          const stats = await fs.stat(entryPath);
          fileCount++;
          totalSize += stats.size;
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // directory may not exist yet
  }

  return { fileCount, totalSize };
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export async function GET(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const { fileCount, totalSize } = await calculateStats(workspaceResult.workspace.rootPath);
    return NextResponse.json({
      success: true,
      data: {
        fileCount,
        totalSize,
        totalSizeHuman: formatSize(totalSize),
      },
    });
  } catch (error) {
    console.error('[API] Workspace stats error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to calculate workspace stats' },
      { status: 500 }
    );
  }
}
