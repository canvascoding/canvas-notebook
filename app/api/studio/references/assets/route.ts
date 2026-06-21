/**
 * Studio reference assets listing API
 * Lists available media files from studio outputs, studio asset references, and user uploads
 */
import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { auth } from '@/app/lib/auth';
import type { FileNode } from '@/app/lib/filesystem/workspace-files';
import { buildGenericFileTree } from '@/app/lib/filesystem/workspace-files';
import { getStudioEditsRoot } from '@/app/lib/integrations/studio-workspace';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { db } from '@/app/lib/db';
import { studioGenerationOutputs, studioGenerations } from '@/app/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { resolveStudioScope, studioVisibilityCondition } from '@/app/lib/integrations/studio-scope';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav']);
const IMAGE_GRID_PREVIEW_WIDTH = 256;
const DEFAULT_MEDIA_PREVIEW_WIDTH = 480;
type AssetKind = 'image' | 'video' | 'audio';

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

function getKind(extension: string): AssetKind | null {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return null;
}

function matchesKind(extension: string, requestedKind: AssetKind): boolean {
  return getKind(extension) === requestedKind;
}

function getAssetPreviewUrl(filePath: string, kind: AssetKind): string {
  if (kind === 'image') {
    return toPreviewUrl(filePath, IMAGE_GRID_PREVIEW_WIDTH, { preset: 'mini' });
  }

  return toPreviewUrl(filePath, DEFAULT_MEDIA_PREVIEW_WIDTH);
}

interface AssetItem {
  path: string;
  name: string;
  kind: AssetKind;
  size?: number;
  modified?: number;
  mediaUrl: string;
  previewUrl: string;
}

function isVeoGenerationOutput(outputMetadata: string | null, generationProvider: string | null, generationModel: string | null): boolean {
  if (generationProvider === 'veo' && generationModel?.startsWith('veo-')) {
    return true;
  }

  if (!outputMetadata) {
    return false;
  }

  try {
    const parsed = JSON.parse(outputMetadata) as { provider?: unknown; model?: unknown };
    return parsed.provider === 'gemini' && typeof parsed.model === 'string' && parsed.model.startsWith('veo-');
  } catch {
    return false;
  }
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
    const kindParam = (searchParams.get('kind') || 'image').trim().toLowerCase();
    const requestedKind: AssetKind = kindParam === 'video' || kindParam === 'audio' ? kindParam : 'image';
    const veoOnly = searchParams.get('veoOnly') === 'true';
    const limitRaw = Number(searchParams.get('limit') || '300');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 300;
    const depthRaw = Number(searchParams.get('depth') || '8');
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(depthRaw, 12)) : 8;
    const studioVisibility = studioVisibilityCondition(resolveStudioScope(session.user.id), {
      userId: studioGenerations.userId,
      organizationId: studioGenerations.organizationId,
      createdByUserId: studioGenerations.createdByUserId,
    });

    if (veoOnly) {
      if (requestedKind !== 'video') {
        return NextResponse.json({ success: true, data: [], total: 0 });
      }

      const rows = await db.select({
        filePath: studioGenerationOutputs.filePath,
        fileName: studioGenerationOutputs.fileName,
        fileSize: studioGenerationOutputs.fileSize,
        mimeType: studioGenerationOutputs.mimeType,
        metadata: studioGenerationOutputs.metadata,
        createdAt: studioGenerationOutputs.createdAt,
        provider: studioGenerations.provider,
        model: studioGenerations.model,
      })
        .from(studioGenerationOutputs)
        .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
        .where(and(
          studioVisibility,
          eq(studioGenerationOutputs.type, 'video'),
        ))
        .orderBy(desc(studioGenerationOutputs.createdAt))
        .limit(limit);

      const filtered = rows
        .filter((row) => row.filePath && isVeoGenerationOutput(row.metadata, row.provider, row.model))
        .filter((row) => !query || row.filePath.toLowerCase().includes(query) || (row.fileName || '').toLowerCase().includes(query))
        .map((row): AssetItem => ({
          path: row.filePath.startsWith('studio/') ? row.filePath : `studio/outputs/${row.filePath}`,
          name: row.fileName || row.filePath.split('/').pop() || row.filePath,
          kind: 'video',
          size: row.fileSize ?? undefined,
          modified: row.createdAt?.getTime(),
          mediaUrl: toMediaUrl(row.filePath),
          previewUrl: getAssetPreviewUrl(row.filePath, 'video'),
        }));

      return NextResponse.json({
        success: true,
        data: filtered,
        total: filtered.length,
      });
    }

    const outputType = requestedKind === 'audio' ? 'sound' : requestedKind;
    const outputRows = await db.select({
      filePath: studioGenerationOutputs.filePath,
      fileName: studioGenerationOutputs.fileName,
      fileSize: studioGenerationOutputs.fileSize,
      createdAt: studioGenerationOutputs.createdAt,
      type: studioGenerationOutputs.type,
    })
      .from(studioGenerationOutputs)
      .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
      .where(and(
        studioVisibility,
        eq(studioGenerationOutputs.type, outputType),
      ))
      .orderBy(desc(studioGenerationOutputs.createdAt))
      .limit(limit);
    // Scan aspect-ratio edits (data/studio/edits)
    const editsTree = await safeBuildGenericFileTree(getStudioEditsRoot(), depth);
    // Scan user-uploaded studio references (data/user-uploads/studio-references)
    const uploadsTree = await safeBuildGenericFileTree(getUserUploadsStudioRefRoot(), depth);

    const allFiles = [
      ...outputRows.map((row): FileNode => ({
        type: 'file',
        name: row.fileName || row.filePath.split('/').pop() || row.filePath,
        path: row.filePath.startsWith('studio/') ? row.filePath : `studio/outputs/${row.filePath}`,
        size: row.fileSize ?? undefined,
        modified: row.createdAt ? Math.floor(row.createdAt.getTime() / 1000) : undefined,
      })),
      ...walkFiles(editsTree).map((n) => ({
        ...n,
        path: n.path.startsWith('studio/') ? n.path : `studio/edits/${n.path}`,
      })),
      ...walkFiles(uploadsTree).map((n) => ({
        ...n,
        path: n.path.startsWith('user-uploads/') ? n.path : `user-uploads/studio-references/${n.path}`,
      })),
    ];

    const filtered: AssetItem[] = [];
    for (const file of allFiles) {
      const ext = getExtension(file.path);
      if (!matchesKind(ext, requestedKind)) {
        continue;
      }
      const kind = getKind(ext) || requestedKind;

      if (query && !file.path.toLowerCase().includes(query) && !file.name.toLowerCase().includes(query)) {
        continue;
      }

      filtered.push({
        path: file.path,
        name: file.name,
        kind,
        size: file.size,
        modified: file.modified,
        mediaUrl: toMediaUrl(file.path),
        previewUrl: getAssetPreviewUrl(file.path, kind),
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
