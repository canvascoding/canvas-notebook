import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readStudioReferenceFile } from '@/app/lib/integrations/studio-workspace';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

const CONTENT_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  png: 'image/png',
  wav: 'audio/wav',
  webp: 'image/webp',
};

/**
 * GET /api/studio/references/:id
 * Serve a saved reference image.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'File ID required' }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = await readStudioReferenceFile(studioRequest.scope.storage, id);
  } catch {
    return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
  }

  const uint8Array = new Uint8Array(buffer);
  const extension = id.split('.').pop()?.toLowerCase() ?? '';

  return new NextResponse(uint8Array, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
