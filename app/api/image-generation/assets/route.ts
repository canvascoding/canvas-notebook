import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { buildFileTree } from '@/app/lib/filesystem/workspace-files';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  IMAGE_GENERATION_ROOT_DIR,
  ensureImageGenerationWorkspace,
} from '@/app/lib/integrations/image-generation-workspace';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

interface AssetItem {
  path: string;
  name: string;
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

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const limited = rateLimit(request, {
      limit: 60,
      windowMs: 60_000,
      keyPrefix: 'image-generation-assets',
    });
    if (!limited.ok) {
      return limited.response;
    }

    await ensureImageGenerationWorkspace();

    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim().toLowerCase();
    if (query.length > 200) {
      return NextResponse.json({ success: false, error: 'Search query too long.' }, { status: 400 });
    }

    const limitRaw = Number(searchParams.get('limit') || '200');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 200;
    const depthRaw = Number(searchParams.get('depth') || '6');
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(depthRaw, 10)) : 6;

    const tree = await buildFileTree(IMAGE_GENERATION_ROOT_DIR, depth);
    const files = walkFiles(tree);

    const filtered: AssetItem[] = [];
    for (const file of files) {
      if (!file.path.startsWith(`${IMAGE_GENERATION_ROOT_DIR}/`)) {
        continue;
      }

      const ext = getExtension(file.path);
      if (!IMAGE_EXTENSIONS.has(ext)) {
        continue;
      }

      if (query && !file.path.toLowerCase().includes(query) && !file.name.toLowerCase().includes(query)) {
        continue;
      }

      filtered.push({
        path: file.path,
        name: file.name,
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
    console.error('[API] image-generation/assets error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load image generation assets';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
