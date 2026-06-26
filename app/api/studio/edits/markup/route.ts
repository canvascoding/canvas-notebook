import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { auth } from '@/app/lib/auth';
import { loadMediaReference } from '@/app/lib/integrations/media-reference-resolver';
import { ensureStudioEditsWorkspace, writeEditFile } from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';

function parseDataUrl(value: unknown): { mimeType: string; buffer: Buffer } {
  if (typeof value !== 'string') {
    throw new Error('maskDataUrl is required');
  }

  const match = value.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error('maskDataUrl must be a base64 data URL');
  }

  return {
    mimeType: match[1] || 'image/png',
    buffer: Buffer.from(match[2] || '', 'base64'),
  };
}

function buildMarkupFileName(sourcePath: string) {
  const base = path.posix.parse(sourcePath.split(/[?#]/, 1)[0] || 'image').name || 'image';
  const safeBase = base
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 48) || 'image';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = crypto.randomUUID().slice(0, 8);
  return `${safeBase}-markup-${timestamp}-${id}.png`;
}

async function normalizeMarkupOverlay(maskBuffer: Buffer, width: number, height: number) {
  const { data, info } = await sharp(maskBuffer, { limitInputPixels: false })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const output = Buffer.from(data);
  const maxAlpha = 72;
  const minAlpha = 28;

  for (let index = 0; index < output.length; index += info.channels) {
    const alpha = output[index + 3] || 0;
    if (alpha === 0) continue;

    output[index] = 38;
    output[index + 1] = 132;
    output[index + 2] = 255;
    output[index + 3] = Math.min(maxAlpha, Math.max(minAlpha, Math.round(alpha * 0.45)));
  }

  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
    limitInputPixels: false,
  })
    .png()
    .toBuffer();
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sourcePath?: string; maskDataUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath.trim() : '';
  if (!sourcePath) {
    return NextResponse.json({ success: false, error: 'sourcePath is required' }, { status: 400 });
  }

  try {
    const source = await loadMediaReference(sourcePath, { userId: session.user.id, allowedTypes: ['image'] });
    const mask = parseDataUrl(body.maskDataUrl);
    if (!mask.mimeType.startsWith('image/')) {
      return NextResponse.json({ success: false, error: 'maskDataUrl must be an image' }, { status: 400 });
    }

    const sourceMeta = await sharp(source.bytes, { limitInputPixels: false }).rotate().metadata();
    const width = sourceMeta.width || source.width || 0;
    const height = sourceMeta.height || source.height || 0;
    if (width <= 0 || height <= 0) {
      throw new Error('Could not read source image dimensions');
    }

    const normalizedSource = await sharp(source.bytes, { limitInputPixels: false })
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer();
    const normalizedMask = await normalizeMarkupOverlay(mask.buffer, width, height);

    const output = await sharp(normalizedSource, { limitInputPixels: false })
      .composite([{ input: normalizedMask, left: 0, top: 0 }])
      .png({ compressionLevel: 6 })
      .toBuffer();

    const fileName = buildMarkupFileName(sourcePath);
    await ensureStudioEditsWorkspace();
    await writeEditFile(fileName, output);

    const editPath = `studio/edits/${fileName}`;
    return NextResponse.json({
      success: true,
      edit: {
        path: editPath,
        name: fileName,
        mediaUrl: toMediaUrl(editPath),
        previewUrl: toPreviewUrl(editPath, 960),
        width,
        height,
        mimeType: 'image/png',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create markup image';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
