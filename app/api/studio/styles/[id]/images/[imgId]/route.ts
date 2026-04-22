import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getStyleImageBuffer, deleteStyleImage } from '@/app/lib/integrations/studio-style-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import sharp from 'sharp';

const THUMB_MAX_WIDTH = 256;
const THUMB_MAX_HEIGHT = 256;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imgId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id, imgId } = await params;
  const size = request.nextUrl.searchParams.get('size');
  try {
    const { buffer, mimeType, fileName } = await getStyleImageBuffer(id, session.user.id, imgId);
    const headers = new Headers();
    headers.set('Cache-Control', 'private, max-age=86400');

    if (size === 'thumb') {
      const thumbBuffer = await sharp(buffer)
        .resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      headers.set('Content-Type', 'image/jpeg');
      headers.set('Content-Disposition', `inline; filename="thumb_${fileName}"`);
      return new NextResponse(new Uint8Array(thumbBuffer), { status: 200, headers });
    }

    headers.set('Content-Type', mimeType);
    headers.set('Content-Disposition', `inline; filename="${fileName}"`);
    return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: err.userMessage }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; imgId: string }> }
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id, imgId } = await params;
  try {
    await deleteStyleImage(id, session.user.id, imgId);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: err.userMessage }, { status: 404 });
    }
    throw err;
  }
}
