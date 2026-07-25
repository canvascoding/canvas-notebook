import fs from 'node:fs/promises';
import path from 'node:path';

import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  getPreviewContentType,
  getPreviewPreset,
  isSupportedPreviewExtension,
  renderCachedMediaPreview,
  resolvePreviewWidth,
} from '@/app/lib/files/media-preview';
import { resolveValidatedStudioPath } from '@/app/lib/integrations/studio-paths';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { resolveMobileStudioOutput } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ outputId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: mobileStudioResponseHeaders },
    );
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;

  try {
    const { outputId } = await context.params;
    const output = await resolveMobileStudioOutput({ scope: studioRequest.scope, outputId });
    const fullPath = resolveValidatedStudioPath(output.filePath);
    if (!fullPath) {
      return NextResponse.json(
        { success: false, error: 'Output path is invalid.', code: 'INVALID_OUTPUT' },
        { status: 400, headers: mobileStudioResponseHeaders },
      );
    }
    const stats = await fs.stat(fullPath).catch(() => null);
    if (!stats?.isFile()) {
      return NextResponse.json(
        { success: false, error: 'Output file was not found.', code: 'OUTPUT_FILE_NOT_FOUND' },
        { status: 404, headers: mobileStudioResponseHeaders },
      );
    }
    const extension = path.extname(output.filePath || output.fileName).slice(1).toLowerCase();
    if (!isSupportedPreviewExtension(extension)) {
      return NextResponse.json(
        { success: false, error: 'This output has no visual preview.', code: 'OUTPUT_PREVIEW_UNAVAILABLE' },
        { status: 415, headers: mobileStudioResponseHeaders },
      );
    }
    const preset = getPreviewPreset('mini');
    const width = resolvePreviewWidth(new URL(request.url).searchParams.get('w'), preset);
    const preview = await renderCachedMediaPreview({
      inputPath: fullPath,
      cacheIdentity: `mobile-studio-output:${output.id}`,
      extension,
      width,
      preset,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
    const responseHeaders = {
      ...mobileStudioResponseHeaders,
      'Cache-Control': 'private, max-age=86400',
      'Content-Type': getPreviewContentType(preview.format),
      ETag: preview.etag,
    };
    if (request.headers.get('if-none-match') === preview.etag) {
      return new NextResponse(null, { status: 304, headers: responseHeaders });
    }
    return new NextResponse(preview.body, { headers: responseHeaders });
  } catch (error) {
    return mobileStudioErrorResponse(error, '[API] Mobile Studio output preview failed:');
  }
}
