import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { readFile } from '@/app/lib/filesystem/upload-handler';

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

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ success: false, error: 'File ID required' }, { status: 400 });
  }

  const buffer = await readFile(id);
  if (!buffer) {
    return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
  }

  const uint8Array = new Uint8Array(buffer);

  return new NextResponse(uint8Array, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000',
    },
  });
}
