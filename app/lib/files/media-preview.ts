import 'server-only';

import { spawn } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'node:path';
import sharp from 'sharp';

const CACHE_ROOT = '/tmp/canvas-media-cache';
const FFMPEG_BIN = 'ffmpeg';
const MAX_WIDTH = 1920;
const MIN_WIDTH = 64;
const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'svg', 'avif', 'bmp', 'tif', 'tiff', 'mp4', 'webm', 'mov', 'avi', 'mkv']);
const SHARP_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'svg', 'avif', 'bmp', 'tif', 'tiff']);

export type PreviewFormat = 'jpg' | 'png' | 'webp';
export type PreviewPreset = 'default' | 'mini';

interface PreviewProfile {
  defaultWidth: number;
  maxWidth: number;
  format: PreviewFormat;
}

export interface CachedMediaPreview {
  body: ArrayBuffer;
  etag: string;
  format: PreviewFormat;
}

const PREVIEW_PROFILES: Record<PreviewPreset, PreviewProfile> = {
  default: {
    defaultWidth: 1280,
    maxWidth: MAX_WIDTH,
    format: 'jpg',
  },
  mini: {
    defaultWidth: 192,
    maxWidth: 320,
    format: 'webp',
  },
};

export function getPreviewPreset(rawPreset: string | null): PreviewPreset {
  return rawPreset === 'mini' ? 'mini' : 'default';
}

export function resolvePreviewWidth(widthParam: string | null, preset: PreviewPreset): number {
  const profile = PREVIEW_PROFILES[preset];
  const widthRaw = Number(widthParam || '');
  return Number.isFinite(widthRaw)
    ? Math.min(Math.max(widthRaw, MIN_WIDTH), profile.maxWidth)
    : profile.defaultWidth;
}

export function getPreviewContentType(format: PreviewFormat): string {
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export function isSupportedPreviewExtension(extension: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extension.toLowerCase());
}

function getOutputFormat(extension: string, preset: PreviewPreset): PreviewFormat {
  if (preset === 'mini' && extension !== 'gif') {
    return PREVIEW_PROFILES.mini.format;
  }

  return extension === 'png' ? 'png' : 'jpg';
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateVideoThumbnail(inputPath: string, outputPath: string, width: number, format: PreviewFormat) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vf',
    `scale='min(iw,${width})':-2`,
    '-vframes',
    '1',
    '-y',
  ];

  if (format === 'jpg') {
    args.push('-q:v', '3');
  } else {
    args.push('-compression_level', '3');
  }

  args.push(outputPath);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function generateImageThumbnail(
  inputPath: string,
  outputPath: string,
  width: number,
  format: PreviewFormat,
  preset: PreviewPreset,
) {
  let image = sharp(inputPath, { animated: false, limitInputPixels: false }).rotate().resize({
    width,
    withoutEnlargement: true,
    fit: 'inside',
  });

  if (format === 'png') {
    image = image.png({
      compressionLevel: preset === 'mini' ? 9 : 6,
      palette: preset === 'mini',
    });
  } else if (format === 'webp') {
    image = image.webp({
      quality: preset === 'mini' ? 58 : 75,
      effort: preset === 'mini' ? 2 : 4,
    });
  } else {
    image = image.jpeg({
      quality: preset === 'mini' ? 58 : 82,
      mozjpeg: true,
    });
  }

  await image.toFile(outputPath);
}

async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  extension: string,
  width: number,
  format: PreviewFormat,
  preset: PreviewPreset,
) {
  if (SHARP_EXTENSIONS.has(extension)) {
    return generateImageThumbnail(inputPath, outputPath, width, format, preset);
  }

  return generateVideoThumbnail(inputPath, outputPath, width, format);
}

export async function renderCachedMediaPreview({
  inputPath,
  cacheIdentity,
  extension,
  width,
  preset,
  size,
  mtimeMs,
}: {
  inputPath: string;
  cacheIdentity: string;
  extension: string;
  width: number;
  preset: PreviewPreset;
  size: number;
  mtimeMs: number;
}): Promise<CachedMediaPreview> {
  const normalizedExtension = extension.toLowerCase();
  const format = getOutputFormat(normalizedExtension, preset);
  const cacheKey = crypto
    .createHash('sha1')
    .update(`${cacheIdentity}:${size}:${mtimeMs}:${width}:${preset}:${format}`)
    .digest('hex');
  const cacheFile = path.join(CACHE_ROOT, `${cacheKey}.${format}`);

  await ensureDir(CACHE_ROOT);

  if (!(await fileExists(cacheFile))) {
    const tmpFile = path.join(CACHE_ROOT, `${cacheKey}-${process.pid}-${crypto.randomUUID()}.tmp.${format}`);
    try {
      await generateThumbnail(inputPath, tmpFile, normalizedExtension, width, format, preset);
      await fs.rename(tmpFile, cacheFile);
    } catch (error) {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  const cacheStats = await fs.stat(cacheFile);
  const buffer = await fs.readFile(cacheFile);
  const body = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(body).set(buffer);

  return {
    body,
    etag: `W/"${cacheStats.size}-${cacheStats.mtimeMs}"`,
    format,
  };
}
