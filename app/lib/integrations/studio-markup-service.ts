import 'server-only';

import crypto from 'node:crypto';
import path from 'node:path';

import sharp from 'sharp';

import { loadMediaReference } from '@/app/lib/integrations/media-reference-resolver';
import { canReadStudioMediaPath } from '@/app/lib/integrations/studio-media-access';
import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import {
  ensureStudioEditsWorkspace,
  generateEditPath,
  writeEditFile,
} from '@/app/lib/integrations/studio-workspace';

function parseDataUrl(value: unknown): { mimeType: string; buffer: Buffer } {
  if (typeof value !== 'string') throw new Error('maskDataUrl is required');
  const match = value.match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new Error('maskDataUrl must be a base64 data URL');
  const buffer = Buffer.from(match[2] || '', 'base64');
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('maskDataUrl exceeds the supported size');
  return { mimeType: match[1] || 'image/png', buffer };
}

function buildMarkupFileName(sourcePath: string) {
  const base = path.posix.parse(sourcePath.split(/[?#]/u, 1)[0] || 'image').name || 'image';
  const safeBase = base
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
    .slice(0, 48) || 'image';
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  return `${safeBase}-markup-${timestamp}-${crypto.randomUUID().slice(0, 8)}.png`;
}

async function normalizeMarkupOverlay(maskBuffer: Buffer, width: number, height: number) {
  const { data, info } = await sharp(maskBuffer, { limitInputPixels: false })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  for (let index = 0; index < output.length; index += info.channels) {
    const alpha = output[index + 3] || 0;
    if (alpha === 0) continue;
    output[index] = 38;
    output[index + 1] = 132;
    output[index + 2] = 255;
    output[index + 3] = Math.min(72, Math.max(28, Math.round(alpha * 0.45)));
  }
  return sharp(output, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: false })
    .png()
    .toBuffer();
}

export async function createStudioMarkupEdit(input: {
  sourcePath: string;
  maskDataUrl: unknown;
  userId: string;
  scope: StudioScope;
}) {
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) throw new Error('sourcePath is required');
  if (sourcePath.startsWith('studio/') && !(await canReadStudioMediaPath(sourcePath, input.scope))) {
    throw new Error('Source image is not available in this workspace');
  }
  const source = await loadMediaReference(sourcePath, { userId: input.userId, allowedTypes: ['image'] });
  const mask = parseDataUrl(input.maskDataUrl);
  if (!mask.mimeType.startsWith('image/')) throw new Error('maskDataUrl must be an image');

  const sourceMeta = await sharp(source.bytes, { limitInputPixels: false }).rotate().metadata();
  const width = sourceMeta.width || source.width || 0;
  const height = sourceMeta.height || source.height || 0;
  if (width <= 0 || height <= 0) throw new Error('Could not read source image dimensions');

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

  const name = buildMarkupFileName(sourcePath);
  await ensureStudioEditsWorkspace(input.scope.storage);
  const editPath = generateEditPath(input.scope.storage, name);
  await writeEditFile(editPath, output);
  return { path: editPath, name, width, height, mimeType: 'image/png' as const, size: output.length };
}
