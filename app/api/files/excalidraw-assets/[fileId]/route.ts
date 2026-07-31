import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { loadExcalidrawAsset } from '@/app/lib/excalidraw-collaboration/assets';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const rateLimit = applyRateLimit(request, { limit: 600, windowMs: 60_000, keyPrefix: 'excalidraw-asset-download' });
  if (rateLimit) return rateLimit;
  const { fileId } = await params;
  try {
    const asset = await loadExcalidrawAsset({ workspaceId: workspaceResult.workspace.workspaceId, fileId });
    if (!asset) return NextResponse.json({ success: false, error: 'Asset not found.' }, { status: 404 });
    const svgHeaders = asset.metadata.mimeType === 'image/svg+xml'
      ? {
          'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          'Cross-Origin-Resource-Policy': 'same-origin',
        }
      : {};
    return new NextResponse(new Uint8Array(asset.data), {
      headers: {
        'Content-Type': asset.metadata.mimeType,
        'Content-Length': String(asset.data.length),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${asset.metadata.contentHash}"`,
        ...svgHeaders,
      },
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Asset download failed.',
    }, { status: 500 });
  }
}
