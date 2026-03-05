import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { buildFileTree } from '@/app/lib/filesystem/workspace-files';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  NANO_BANANA_ROOT_DIR,
  ensureNanoBananaWorkspace,
} from '@/app/lib/integrations/nano-banana-workspace';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);

type AssetKind = 'image' | 'video' | 'all';

interface AssetItem {
  path: string;
  name: string;
  kind: 'image' | 'video';
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

function matchesKind(extension: string, kind: AssetKind): boolean {
  if (kind === 'image') return IMAGE_EXTENSIONS.has(extension);
  if (kind === 'video') return VIDEO_EXTENSIONS.has(extension);
  return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
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
      keyPrefix: 'nano-banana-assets',
    });
    if (!limited.ok) {
      return limited.response;
    }

    await ensureNanoBananaWorkspace();

    const { searchParams } = new URL(request.url);
    const kindParam = (searchParams.get('kind') || 'all').toLowerCase();
    const kind: AssetKind = kindParam === 'image' || kindParam === 'video' ? kindParam : 'all';
    const query = (searchParams.get('q') || '').trim().toLowerCase();
    if (query.length > 200) {
      return NextResponse.json({ success: false, error: 'Search query too long.' }, { status: 400 });
    }
    const limitRaw = Number(searchParams.get('limit') || '200');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200)) : 200;
    const depthRaw = Number(searchParams.get('depth') || '6');
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(depthRaw, 10)) : 6;

    const tree = await buildFileTree(NANO_BANANA_ROOT_DIR, depth);
    const files = walkFiles(tree);

    const filtered: AssetItem[] = [];
    for (const file of files) {
      const ext = getExtension(file.path);
      if (!file.path.startsWith(`${NANO_BANANA_ROOT_DIR}/`)) {
        continue;
      }
      if (!matchesKind(ext, kind)) {
        continue;
      }

      if (query && !file.path.toLowerCase().includes(query) && !file.name.toLowerCase().includes(query)) {
        continue;
      }

      const isImage = IMAGE_EXTENSIONS.has(ext);
      filtered.push({
        path: file.path,
        name: file.name,
        kind: isImage ? 'image' : 'video',
        size: file.size,
        modified: file.modified,
        mediaUrl: toMediaUrl(file.path),
        previewUrl: isImage ? toPreviewUrl(file.path, 480) : toMediaUrl(file.path),
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
    console.error('[API] nano-banana/assets error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load Nano Banana assets';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
