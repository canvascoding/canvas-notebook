import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { storeExcalidrawAsset } from '@/app/lib/excalidraw-collaboration/assets';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const rateLimit = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'excalidraw-asset-upload' });
  if (rateLimit) return rateLimit;
  if (!liveCollaborationRuntimeAvailable()) {
    return NextResponse.json(
      { success: false, error: 'Excalidraw collaboration requires Postgres.' },
      { status: 409 },
    );
  }
  const fileId = request.headers.get('x-excalidraw-file-id')?.trim() || '';
  const mimeType = request.headers.get('content-type')?.split(';', 1)[0].trim() || '';
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (!fileId || !mimeType) return NextResponse.json({ success: false, error: 'File id and content type are required.' }, { status: 400 });
  if (contentLength > MAX_ASSET_BYTES) return NextResponse.json({ success: false, error: 'Asset exceeds the 20 MiB limit.' }, { status: 413 });
  try {
    const data = Buffer.from(await request.arrayBuffer());
    if (data.length > MAX_ASSET_BYTES) return NextResponse.json({ success: false, error: 'Asset exceeds the 20 MiB limit.' }, { status: 413 });
    const asset = await storeExcalidrawAsset({
      workspaceId: workspaceResult.workspace.workspaceId,
      fileId,
      mimeType,
      data,
    });
    return NextResponse.json({ success: true, asset }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Asset upload failed.',
    }, { status: 400 });
  }
}
