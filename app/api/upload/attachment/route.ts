import { NextRequest, NextResponse } from 'next/server';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { auth } from '@/app/lib/auth';

const MAX_FILE_SIZE_MB = 10;

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    const maxBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      return NextResponse.json(
        { success: false, error: `File too large. Maximum size: ${MAX_FILE_SIZE_MB} MB` },
        { status: 400 },
      );
    }

    // Convert file to buffer
    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Save using unified handler - ALL file types treated equally
    const uploadedFile = await saveUploadBuffer(buffer, file.name, file.type);

    return NextResponse.json({
      success: true,
      file: {
        id: uploadedFile.id,
        originalName: uploadedFile.originalName,
        mimeType: uploadedFile.mimeType,
        size: uploadedFile.size,
        category: uploadedFile.category,
      },
    });
  } catch (error) {
    console.error('[API] Attachment upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to process file';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
