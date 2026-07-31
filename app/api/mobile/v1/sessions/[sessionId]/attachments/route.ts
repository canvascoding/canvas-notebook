import { NextRequest, NextResponse } from 'next/server';

import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { auth } from '@/app/lib/auth';
import { saveUploadBuffer } from '@/app/lib/filesystem/upload-handler';
import { getImageConversionErrorMessage } from '@/app/lib/images/convert';
import { normalizeUploadImageBuffer } from '@/app/lib/images/upload-conversion';
import { MobileChatError, requireMobileChatSession } from '@/app/lib/mobile/chat';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { toUploadMediaUrl, toUploadPreviewUrl } from '@/app/lib/utils/media-url';

export const dynamic = 'force-dynamic';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Vary': 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(error: unknown): NextResponse {
  if (error instanceof MobileChatError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: responseHeaders },
    );
  }
  console.error('[API] Mobile chat attachment upload failed:', error);
  return NextResponse.json(
    { success: false, code: 'INTERNAL_ERROR', error: 'The attachment could not be uploaded.' },
    { status: 500, headers: responseHeaders },
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authSession = await auth.api.getSession({ headers: request.headers });
  if (!authSession) {
    return NextResponse.json(
      { success: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
      { status: 401, headers: responseHeaders },
    );
  }
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'mobile-chat-attachment' });
  if (!limited.ok) return limited.response;
  try {
    const params = await context.params;
    const workspaceId = request.headers.get('x-canvas-workspace-id')?.trim() || '';
    await requireMobileChatSession({
      userId: authSession.user.id,
      sessionId: params.sessionId,
      workspaceId,
    });
    const parsed = await parseMultipartFormData(request);
    if (!parsed.ok) return parsed.response;
    const value = parsed.formData.get('file');
    if (!(value instanceof File)) {
      throw new MobileChatError('ATTACHMENT_REQUIRED', 'Choose one file to attach.', 400);
    }
    if (value.size < 1 || value.size > MAX_ATTACHMENT_BYTES) {
      throw new MobileChatError('ATTACHMENT_SIZE_INVALID', 'Attachments must be between 1 byte and 10 MB.', 413);
    }
    const originalMimeType = value.type || 'application/octet-stream';
    let normalized;
    try {
      normalized = await normalizeUploadImageBuffer({
        buffer: Buffer.from(await value.arrayBuffer()),
        filename: value.name,
        mimeType: originalMimeType,
        convertParams: null,
      });
    } catch (error) {
      throw new MobileChatError('ATTACHMENT_INVALID', getImageConversionErrorMessage(value.name, error), 400);
    }
    const saved = await saveUploadBuffer(normalized.buffer, normalized.filename, normalized.mimeType, {
      ownerUserId: authSession.user.id,
      workspaceId,
    });
    const isImage = saved.category === 'image' || saved.mimeType.startsWith('image/');
    return NextResponse.json({
      success: true,
      attachment: {
        id: saved.id,
        name: saved.originalName,
        contentKind: isImage ? 'image' : 'document',
        mimeType: saved.mimeType,
        size: saved.size,
        previewUrl: isImage ? toUploadPreviewUrl(saved.id, 192, { preset: 'mini' }) : null,
        mediaUrl: isImage ? toUploadMediaUrl(saved.id) : null,
      },
    }, { status: 201, headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
