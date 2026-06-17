import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';

import { auth } from '@/app/lib/auth';
import {
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
  estimateEmailAttachmentTransferBytes,
  inferEmailAttachmentMimeType,
} from '@/app/lib/email/attachment-types';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { fetchRemoteImageBuffer } from '@/app/lib/images/remote-image-fetch';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type EmailAttachmentUploadCandidate = {
  buffer: Buffer;
  mimeType?: string;
  name: string;
  size: number;
};

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

function remoteImageName(url: URL, mimeType: string) {
  const rawName = path.posix.basename(url.pathname || '');
  if (rawName && rawName !== '.' && rawName !== '/') return rawName;
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType.toLowerCase()] || 'img';
  return `${url.hostname}-image.${extension}`;
}

async function fetchRemoteImage(urlValue: string): Promise<EmailAttachmentUploadCandidate> {
  const remoteImage = await fetchRemoteImageBuffer(urlValue, {
    maxBytes: EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES,
    requireImageMimeType: true,
    tooLargeMessage: 'Image URL exceeds the 20 MB total limit.',
  });

  return {
    buffer: remoteImage.buffer,
    mimeType: remoteImage.mimeType,
    name: remoteImageName(remoteImage.finalUrl, remoteImage.mimeType),
    size: remoteImage.buffer.length,
  };
}

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
    ].filter((file) => file instanceof File && file.size > 0);
    const remoteUrl = formData.get('url')?.toString().trim();

    if (files.length === 0 && !remoteUrl) {
      return NextResponse.json({ success: false, error: 'No files provided' }, { status: 400 });
    }

    if (files.length + (remoteUrl ? 1 : 0) > EMAIL_ATTACHMENT_MAX_FILES) {
      return NextResponse.json(
        { success: false, error: `Maximum ${EMAIL_ATTACHMENT_MAX_FILES} attachments per email.` },
        { status: 400 },
      );
    }

    const candidates: EmailAttachmentUploadCandidate[] = await Promise.all(files.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      return {
        buffer,
        mimeType: file.type || undefined,
        name: file.name,
        size: file.size,
      };
    }));

    if (remoteUrl) {
      candidates.push(await fetchRemoteImage(remoteUrl));
    }

    const estimatedTotal = candidates.reduce((total, file) => total + estimateEmailAttachmentTransferBytes(file.size), 0);
    if (estimatedTotal > EMAIL_ATTACHMENT_TOTAL_LIMIT_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Email attachments exceed the 20 MB total limit.' },
        { status: 413 },
      );
    }

    const uploaded = [];
    for (const file of candidates) {
      const saved = await saveUploadBuffer(file.buffer, file.name, file.mimeType, {
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
