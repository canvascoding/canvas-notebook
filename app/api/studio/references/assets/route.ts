/**
 * Studio reference assets listing API
 * Lists available files in /studio/assets/ and registered media library images
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { buildFileTree } from '@/app/lib/filesystem/workspace-files';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

type AssetKind = 'image' | 'all';

interface AssetItem {
  path: string;
  name: string;
  kind: 'image';
  size?: number;
  modified?: number;
  mediaUrl: string;
  previewUrl: string;
}

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
    const kindParam = (searchParams.get('kind') || 'all').toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const kind: AssetKind = kindParam === 'image' ? 'image' : 'all';
    const query = (searchParams.get('q') || '').trim().toLowerCase();
    const limitRaw = Number(searchParams.get('limit') || '300');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 300;
    const depthRaw = Number(searchParams.get('depth') || '8');
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(depthRaw, 12)) : 8;

    // Scan both studio outputs and uploaded references
    const outputsTree = await buildFileTree('studio/outputs', depth);
    const uploadsTree = await buildFileTree('user-uploads/studio-references', depth);

    const allFiles = [
      ...walkFiles(outputsTree),
      ...walkFiles(uploadsTree),
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
