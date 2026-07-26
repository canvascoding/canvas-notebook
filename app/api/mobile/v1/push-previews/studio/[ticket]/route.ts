import fs from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/app/lib/db';
import { studioGenerationOutputs } from '@/app/lib/db/schema';
import {
  getPreviewContentType,
  isSupportedPreviewExtension,
  renderCachedMediaPreview,
} from '@/app/lib/files/media-preview';
import { resolveValidatedStudioPath } from '@/app/lib/integrations/studio-paths';
import { verifyStudioPushPreviewTicket } from '@/app/lib/mobile/push-preview';

export const dynamic = 'force-dynamic';

const PREVIEW_WIDTH = 1_024;

function unavailable(): NextResponse {
  return new NextResponse(null, {
    status: 404,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticket: string }> },
) {
  try {
    const { ticket } = await context.params;
    const claims = verifyStudioPushPreviewTicket(ticket);
    const [output] = await db.select({
      id: studioGenerationOutputs.id,
      type: studioGenerationOutputs.type,
      filePath: studioGenerationOutputs.filePath,
      fileName: studioGenerationOutputs.fileName,
      mimeType: studioGenerationOutputs.mimeType,
    })
      .from(studioGenerationOutputs)
      .where(eq(studioGenerationOutputs.id, claims.outputId))
      .limit(1);
    if (
      !output
      || output.type !== 'image'
      || !output.mimeType?.startsWith('image/')
      || !output.filePath
    ) {
      return unavailable();
    }

    const fullPath = resolveValidatedStudioPath(output.filePath);
    if (!fullPath) return unavailable();
    const stats = await fs.stat(fullPath).catch(() => null);
    if (!stats?.isFile()) return unavailable();
    const extension = path.extname(output.filePath || output.fileName || '').slice(1).toLowerCase();
    if (!isSupportedPreviewExtension(extension)) return unavailable();

    const preview = await renderCachedMediaPreview({
      inputPath: fullPath,
      cacheIdentity: `studio-push-preview:${output.id}`,
      extension,
      width: PREVIEW_WIDTH,
      preset: 'default',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
    return new NextResponse(preview.body, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Disposition': `inline; filename="canvas-studio-preview.${preview.format}"`,
        'Content-Length': String(preview.body.byteLength),
        'Content-Type': getPreviewContentType(preview.format),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return unavailable();
  }
}
