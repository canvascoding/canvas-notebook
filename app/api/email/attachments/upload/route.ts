import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
  estimateEmailAttachmentTransferBytes,
  inferEmailAttachmentMimeType,
} from '@/app/lib/email/attachment-types';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const limited = rateLimit(request, { limit: 40, windowMs: 60_000, keyPrefix: 'email-attachments-upload' });
  if (!limited.ok) return limited.response;

  try {
    const parsedFormData = await parseMultipartFormData(request);
    if (!parsedFormData.ok) return parsedFormData.response;

    const formData = parsedFormData.formData;
    const files = [
      ...(formData.getAll('files') as File[]),
      ...(formData.getAll('file') as File[]),
    ].filter((file) => file instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ success: false, error: 'No files provided' }, { status: 400 });
    }

    if (files.length > EMAIL_ATTACHMENT_MAX_FILES) {
      return NextResponse.json(
        { success: false, error: `Maximum ${EMAIL_ATTACHMENT_MAX_FILES} attachments per email.` },
        { status: 400 },
      );
    }

    const estimatedTotal = files.reduce((total, file) => total + estimateEmailAttachmentTransferBytes(file.size), 0);
    if (estimatedTotal > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Email attachments exceed the 20 MB total limit.' },
        { status: 413 },
      );
    }

    const uploaded = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const saved = await saveUploadBuffer(buffer, file.name, file.type || undefined, {
        maxBytes: EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
      });
      uploaded.push({
        id: `upload:${saved.id}`,
        source: 'upload',
        uploadId: saved.id,
        name: saved.originalName,
        mimeType: inferEmailAttachmentMimeType(saved.originalName, saved.mimeType),
        size: saved.size,
      });
    }

    return NextResponse.json({ success: true, files: uploaded });
  } catch (error) {
    console.error('[API] Email attachment upload error:', error);
    const message = error instanceof Error ? error.message : 'Failed to upload email attachments';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
