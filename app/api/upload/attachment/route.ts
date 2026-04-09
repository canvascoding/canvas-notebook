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
    const files = formData.getAll('file') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    const maxBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    const uploadedFiles = [];
    const errors: string[] = [];

    for (const file of files) {
      if (file.size > maxBytes) {
        errors.push(`${file.name}: File too large. Maximum size: ${MAX_FILE_SIZE_MB} MB`);
        continue;
      }

      try {
        // Convert file to buffer
        const buffer = Buffer.from(await file.arrayBuffer());
        
        // Save using unified handler - ALL file types treated equally
        const uploadedFile = await saveUploadBuffer(buffer, file.name, file.type);

        uploadedFiles.push({
          id: uploadedFile.id,
          originalName: uploadedFile.originalName,
          mimeType: uploadedFile.mimeType,
          size: uploadedFile.size,
          category: uploadedFile.category,
        });
      } catch (err) {
        console.error(`Upload failed for ${file.name}`, err);
        errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Upload failed'}`);
      }
    }

    if (uploadedFiles.length === 0) {
      return NextResponse.json(
        { success: false, error: errors.join('; ') || 'All uploads failed' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      files: uploadedFiles,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('[API] Attachment upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to process files';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
