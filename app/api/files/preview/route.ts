import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { auth } from '@/app/lib/auth';
import { validatePath } from '@/app/lib/filesystem/workspace-files';
import { resolveValidatedStudioAssetPath, resolveValidatedStudioOutputPath } from '@/app/lib/integrations/studio-paths';
import { getUserUploadsStudioRefRoot } from '@/app/lib/runtime-data-paths';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const CACHE_ROOT = '/tmp/canvas-media-cache';
const FFMPEG_BIN = 'ffmpeg';
const MAX_WIDTH = 1920;
const MIN_WIDTH = 64;
const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);
const SHARP_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

type PreviewFormat = 'jpg' | 'png' | 'webp';
type PreviewPreset = 'default' | 'mini';

interface PreviewProfile {
  defaultWidth: number;
  maxWidth: number;
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

function buildMediaUrl(filePath: string) {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/media/${encodedPath}`;
}

function getPreviewPreset(rawPreset: string | null): PreviewPreset {
  return rawPreset === 'mini' ? 'mini' : 'default';
}

function getOutputFormat(extension: string, preset: PreviewPreset): PreviewFormat {
  if (preset === 'mini' && extension !== 'gif') {
    return PREVIEW_PROFILES.mini.format;
  }

  return extension === 'png' ? 'png' : 'jpg';
}

function getContentType(format: PreviewFormat) {
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return 'image/jpeg';
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

export async function GET(request: NextRequest) {
  try {
    const limited = rateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: 'files-preview',
    });
    if (!limited.ok) {
      return limited.response;
    }

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const widthParam = searchParams.get('w') || '';
    const preset = getPreviewPreset(searchParams.get('preset'));
    const profile = PREVIEW_PROFILES[preset];

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const widthRaw = Number(widthParam);
    const width = Number.isFinite(widthRaw)
      ? Math.min(Math.max(widthRaw, MIN_WIDTH), profile.maxWidth)
      : profile.defaultWidth;

    const extension = path.posix.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      const mediaPath = buildMediaUrl(filePath);
      // Use X-Forwarded headers to get the actual frontend URL
      const proto = request.headers.get('x-forwarded-proto') || 'https';
      const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'chat.canvasstudios.store';
      const redirectUrl = new URL(mediaPath, `${proto}://${host}`);
      return NextResponse.redirect(redirectUrl);
    }

    // Resolve the full filesystem path based on the virtual path prefix
    let fullPath: string;
    if (filePath.startsWith('studio/outputs/')) {
      const resolved = resolveValidatedStudioOutputPath(filePath.slice('studio/outputs/'.length));
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (filePath.startsWith('studio/assets/')) {
      const resolved = resolveValidatedStudioAssetPath(filePath.slice('studio/assets/'.length));
      if (!resolved) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else if (filePath.startsWith('user-uploads/studio-references/')) {
      const root = getUserUploadsStudioRefRoot();
      const relativePath = filePath.slice('user-uploads/studio-references/'.length);
      const resolved = path.resolve(root, relativePath);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
      }
      fullPath = resolved;
    } else {
      fullPath = validatePath(filePath);
    }

    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    const format = getOutputFormat(extension, preset);
    const cacheKey = crypto
      .createHash('sha1')
      .update(`${filePath}:${stats.size}:${stats.mtimeMs}:${width}:${preset}:${format}`)
      .digest('hex');
    const cacheFile = path.join(CACHE_ROOT, `${cacheKey}.${format}`);

    await ensureDir(CACHE_ROOT);

    if (!(await fileExists(cacheFile))) {
      const tmpFile = path.join(CACHE_ROOT, `${cacheKey}.tmp.${format}`);
      try {
        await generateThumbnail(fullPath, tmpFile, extension, width, format, preset);
        await fs.rename(tmpFile, cacheFile);
      } catch (error) {
        await fs.rm(tmpFile, { force: true }).catch(() => {});
        const mediaPath = buildMediaUrl(filePath);
        // Use X-Forwarded headers to get the actual frontend URL
        const proto = request.headers.get('x-forwarded-proto') || 'https';
        const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'chat.canvasstudios.store';
        const redirectUrl = new URL(mediaPath, `${proto}://${host}`);
        console.error('[API] Preview error:', error);
        return NextResponse.redirect(redirectUrl);
      }
    }

    const cacheStats = await fs.stat(cacheFile);
    const body = await fs.readFile(cacheFile);
    const etag = `W/"${cacheStats.size}-${cacheStats.mtimeMs}"`;
    const requestEtag = request.headers.get('if-none-match');
    if (requestEtag && requestEtag === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    return new NextResponse(body, {
      headers: {
        'Content-Type': getContentType(format),
        'Cache-Control': 'private, max-age=300',
        ETag: etag,
      },
    });
  } catch (error) {
    console.error('[API] Preview error:', error);
    const message = error instanceof Error ? error.message : 'Failed to render preview';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
