/**
 * Studio reference assets listing API
 * Lists available image files from studio outputs, studio asset references, and user uploads
 */
import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { auth } from '@/app/lib/auth';
import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { buildGenericFileTree } from '@/app/lib/filesystem/workspace-files';
import { getStudioOutputsRoot } from '@/app/lib/integrations/studio-workspace';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function getExtension(filePath: string): string {
  const ext = filePath.split('.').pop();
  return ext ? ext.toLowerCase() : '';
}

function walkFiles(nodes: FileNode[], list: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (node.type === 'file') {
      list.push(node);
    }
    if (node.children?.length) {
      walkFiles(node.children, list);
    }
  }
  return list;
}

function matchesKind(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension);
}

interface AssetItem {
  path: string;
  name: string;
  kind: 'image';
  size?: number;
  modified?: number;
  mediaUrl: string;
  previewUrl: string;
}

async function safeBuildGenericFileTree(absoluteBasePath: string, depth: number): Promise<FileNode[]> {
  try {
    await fs.access(absoluteBasePath);
  } catch {
    await fs.mkdir(absoluteBasePath, { recursive: true });
    return [];
  }
  try {
    return await buildGenericFileTree(absoluteBasePath, '.', depth);
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'studio-references',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim().toLowerCase();
    const limitRaw = Number(searchParams.get('limit') || '300');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 300;
    const depthRaw = Number(searchParams.get('depth') || '8');
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(depthRaw, 12)) : 8;

    // Scan studio outputs (data/studio/outputs)
    const outputsTree = await safeBuildGenericFileTree(getStudioOutputsRoot(), depth);
    // Scan user-uploaded studio references (data/user-uploads/studio-references)
    const uploadsTree = await safeBuildGenericFileTree(getUserUploadsStudioRefRoot(), depth);

    const allFiles = [
      ...walkFiles(outputsTree).map((n) => ({
        ...n,
        path: n.path.startsWith('studio/') ? n.path : `studio/outputs/${n.path}`,
      })),
      ...walkFiles(uploadsTree).map((n) => ({
        ...n,
        path: n.path.startsWith('user-uploads/') ? n.path : `user-uploads/studio-references/${n.path}`,
      })),
    ];

    const filtered: AssetItem[] = [];
    for (const file of allFiles) {
      const ext = getExtension(file.path);
      if (!matchesKind(ext)) {
        continue;
      }

      if (query && !file.path.toLowerCase().includes(query) && !file.name.toLowerCase().includes(query)) {
        continue;
      }

      filtered.push({
        path: file.path,
        name: file.name,
        kind: 'image',
        size: file.size,
        modified: file.modified,
        mediaUrl: toMediaUrl(file.path),
        previewUrl: toPreviewUrl(file.path, 480),
      });
    }

    filtered.sort((a, b) => {
      const modifiedA = a.modified || 0;
      const modifiedB = b.modified || 0;
      return modifiedB - modifiedA;
    });

    return NextResponse.json({
      success: true,
      data: filtered.slice(0, limit),
      total: filtered.length,
    });
  } catch (error) {
    console.error('[API] studio/references/assets error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load studio reference assets';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}