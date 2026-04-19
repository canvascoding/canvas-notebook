import { NextRequest, NextResponse } from 'next/server';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { auth } from '@/app/lib/auth';
import { convertImage, getImageConversionErrorMessage, isHeicFile } from '@/app/lib/images/convert';
import { fileTypeFromBuffer } from 'file-type';

const MAX_FILE_SIZE_MB = 10;

interface ConvertParams {
  format: 'jpg' | 'webp' | 'png';
  quality: number;
  maxDimension?: number;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const files = formData.getAll('file') as File[];
    const convertParamsRaw = formData.get('convertParams')?.toString();

    if (!files || files.length === 0) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    let convertParamsList: (ConvertParams | null)[] | null = null;
    if (convertParamsRaw) {
      try {
        const parsed = JSON.parse(convertParamsRaw);
        if (Array.isArray(parsed) && parsed.length === files.length) {
          convertParamsList = parsed;
        }
      } catch {
        // Invalid JSON — ignore convertParams
      }
    }

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
        let buffer: Buffer = Buffer.from(await file.arrayBuffer());
        let filename = file.name;
        let mimeType = file.type || 'application/octet-stream';

        const convertParams = convertParamsList?.[i] ?? null;

        if (convertParams) {
          try {
            const result = await convertImage(buffer, filename, {
              format: convertParams.format,
              quality: convertParams.quality,
              maxDimension: convertParams.maxDimension,
            });
            buffer = result.buffer as Buffer;
            filename = result.filename;
            mimeType = result.mimeType;
          } catch (err) {
            console.error(`[API] Image conversion failed for ${file.name}:`, err);
            errors.push(getImageConversionErrorMessage(file.name, err));
            continue;
          }
        } else if (isImageMimeType(mimeType) || isHeicFile(filename, mimeType)) {
          const detectedType = await fileTypeFromBuffer(buffer);
          const isHeic = isHeicFile(filename, mimeType) ||
            (detectedType?.mime === 'image/heic' || detectedType?.mime === 'image/heif' || detectedType?.mime === 'image/heic-sequence');

          if (isHeic) {
            try {
              const result = await convertImage(buffer, filename, {
                format: 'jpg',
                quality: 80,
              });
              buffer = result.buffer as Buffer;
              filename = result.filename;
              mimeType = result.mimeType;
            } catch (err) {
              console.error(`[API] HEIC auto-conversion failed for ${file.name}:`, err);
              errors.push(getImageConversionErrorMessage(file.name, err));
              continue;
            }
          }
        }

        const uploadedFile = await saveUploadBuffer(buffer, filename, mimeType);

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
