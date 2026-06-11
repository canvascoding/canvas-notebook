import { NextRequest, NextResponse } from 'next/server';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { auth } from '@/app/lib/auth';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { normalizeUploadImageBuffer, parseUploadConvertParams } from '@/app/lib/images/upload-conversion';

const MAX_FILE_SIZE_MB = 10;

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const parsedFormData = await parseMultipartFormData(request);
    if (!parsedFormData.ok) {
      return parsedFormData.response;
    }
    const formData = parsedFormData.formData;
    const files = formData.getAll('file') as File[];
    const convertParamsRaw = formData.get('convertParams')?.toString();

    if (!files || files.length === 0) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    const parsedConvertParams = parseUploadConvertParams(convertParamsRaw, files.length);
    if (!parsedConvertParams.ok) {
      return NextResponse.json({ success: false, error: parsedConvertParams.error }, { status: 400 });
    }
    const convertParamsList = parsedConvertParams.params;

    const maxBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
    const uploadedFiles = [];
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (file.size > maxBytes) {
        errors.push(`${file.name}: File too large. Maximum size: ${MAX_FILE_SIZE_MB} MB`);
        continue;
      }

      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const filename = file.name;
        const mimeType = file.type || 'application/octet-stream';

        const convertParams = convertParamsList?.[i] ?? null;

        let normalized;
        try {
          normalized = await normalizeUploadImageBuffer({
            buffer,
            filename,
            mimeType,
            convertParams,
          });
        } catch (err) {
          console.error(`[API] Image conversion failed for ${file.name}:`, err);
          errors.push(getImageConversionErrorMessage(file.name, err));
          continue;
        }

        const uploadedFile = await saveUploadBuffer(normalized.buffer, normalized.filename, normalized.mimeType);

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
        { status: 400 },
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
