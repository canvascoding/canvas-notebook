import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getPersonaImageBuffer, deletePersonaImage } from '@/app/lib/integrations/studio-persona-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; imgId: string }> }
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { imgId } = await params;
  try {
    const { buffer, mimeType, fileName } = await getPersonaImageBuffer(imgId);
    const headers = new Headers();
    headers.set('Content-Type', mimeType);
    headers.set('Cache-Control', 'private, max-age=86400');
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
    await deletePersonaImage(id, imgId);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: err.userMessage }, { status: 404 });
    }
    throw err;
  }
}