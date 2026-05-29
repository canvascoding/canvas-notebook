import 'server-only';

import { fileTypeFromBuffer } from 'file-type';
import { convertImage, isHeicFile } from '@/app/lib/images/convert';

export interface UploadConvertParams {
  format: 'jpg' | 'webp' | 'png';
  quality: number;
  maxDimension?: number;
}

export interface NormalizedUploadFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  converted: boolean;
}

type ParseResult =
  | { ok: true; params: (UploadConvertParams | null)[] | null }
  | { ok: false; error: string };

const ALLOWED_FORMATS = new Set(['jpg', 'webp', 'png']);
const MIN_QUALITY = 1;
const MAX_QUALITY = 100;
const MIN_MAX_DIMENSION = 256;
const MAX_MAX_DIMENSION = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

export function parseUploadConvertParams(raw: string | null | undefined, expectedLength: number): ParseResult {
  if (!raw) {
    return { ok: true, params: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid image conversion parameters' };
  }

  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return { ok: false, error: 'Image conversion parameter count does not match uploaded files' };
  }

  const params: (UploadConvertParams | null)[] = [];
  for (const item of parsed) {
    if (item === null) {
      params.push(null);
      continue;
    }

    if (!isRecord(item)) {
      return { ok: false, error: 'Invalid image conversion parameter entry' };
    }

    const format = typeof item.format === 'string' ? item.format.toLowerCase() : '';
    if (!ALLOWED_FORMATS.has(format)) {
      return { ok: false, error: 'Unsupported image conversion format' };
    }

    const quality = Number(item.quality);
    if (!Number.isInteger(quality) || quality < MIN_QUALITY || quality > MAX_QUALITY) {
      return { ok: false, error: `Image conversion quality must be between ${MIN_QUALITY} and ${MAX_QUALITY}` };
    }

    const maxDimensionRaw = item.maxDimension;
    let maxDimension: number | undefined;
    if (maxDimensionRaw !== undefined && maxDimensionRaw !== null) {
      maxDimension = Number(maxDimensionRaw);
      if (
        !Number.isInteger(maxDimension) ||
        maxDimension < MIN_MAX_DIMENSION ||
        maxDimension > MAX_MAX_DIMENSION
      ) {
        return { ok: false, error: `Image max dimension must be between ${MIN_MAX_DIMENSION} and ${MAX_MAX_DIMENSION}px` };
      }
    }

    params.push({
      format: format as UploadConvertParams['format'],
      quality,
      ...(maxDimension ? { maxDimension } : {}),
    });
  }

  return { ok: true, params };
}

export async function normalizeUploadImageBuffer(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  convertParams?: UploadConvertParams | null;
}): Promise<NormalizedUploadFile> {
  const detectedType = await fileTypeFromBuffer(params.buffer).catch(() => undefined);
  const sourceMimeType = detectedType?.mime || params.mimeType || 'application/octet-stream';
  const sourceIsImage = isImageMimeType(sourceMimeType) || isImageMimeType(params.mimeType);
  const sourceIsHeic = isHeicFile(params.filename, params.mimeType) || isHeicFile(params.filename, detectedType?.mime);

  if (params.convertParams) {
    if (!sourceIsImage && !sourceIsHeic) {
      throw new Error('Image conversion requested for a non-image file');
    }

    const result = await convertImage(params.buffer, params.filename, {
      format: params.convertParams.format,
      quality: params.convertParams.quality,
      maxDimension: params.convertParams.maxDimension,
      sourceMimeType,
    });

    return {
      buffer: result.buffer,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      converted: true,
    };
  }

  if (sourceIsHeic) {
    const result = await convertImage(params.buffer, params.filename, {
      format: 'jpg',
      quality: 80,
      sourceMimeType,
    });

    return {
      buffer: result.buffer,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      converted: true,
    };
  }

  return {
    buffer: params.buffer,
    filename: params.filename,
    mimeType: sourceMimeType,
    size: params.buffer.length,
    converted: false,
  };
}
