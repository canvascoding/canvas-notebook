import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { replaceProductImage } from '@/app/lib/integrations/studio-product-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; imgId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id, imgId } = await params;

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) {
    return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
  }
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  try {
    const image = await replaceProductImage(id, imgId, {
      buffer,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: buffer.length,
    });
    return NextResponse.json({ success: true, image });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ success: false, error: err.userMessage }, { status });
    }
    throw err;
  }
}