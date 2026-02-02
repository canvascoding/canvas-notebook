import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { auth } from '@/app/lib/auth';
import { validatePath } from '@/app/lib/ssh/sftp-client';
import { rateLimit } from '@/app/lib/utils/rate-limit';

const CACHE_ROOT = process.env.MEDIA_CACHE_PATH || '/tmp/canvas-media-cache';
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_WIDTH = 1920;
const MIN_WIDTH = 64;
const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

function buildMediaUrl(filePath: string) {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/media/${encodedPath}`;
}

function getOutputFormat(extension: string) {
  return extension === 'png' ? 'png' : 'jpg';
}

function getContentType(format: string) {
  return format === 'png' ? 'image/png' : 'image/jpeg';
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

async function generateThumbnail(inputPath: string, outputPath: string, width: number, format: string) {
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

    if (process.env.SSH_USE_LOCAL_FS !== 'true') {
      return NextResponse.json(
        { success: false, error: 'Preview requires local filesystem mode.' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const widthParam = searchParams.get('w') || '';

    if (!filePath) {
      return NextResponse.json(
        { success: false, error: 'Path parameter is required' },
        { status: 400 }
      );
    }

    const widthRaw = Number(widthParam);
    const width = Number.isFinite(widthRaw)
      ? Math.min(Math.max(widthRaw, MIN_WIDTH), MAX_WIDTH)
      : 1280;

    const extension = path.posix.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      const mediaPath = buildMediaUrl(filePath);
      // Use X-Forwarded headers to get the actual frontend URL
      const proto = request.headers.get('x-forwarded-proto') || 'https';
      const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'chat.canvasstudios.store';
      const redirectUrl = new URL(mediaPath, `${proto}://${host}`);
      return NextResponse.redirect(redirectUrl);
    }

    const fullPath = validatePath(filePath);
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
      return NextResponse.json(
        { success: false, error: 'File not found' },
        { status: 404 }
      );
    }

    const format = getOutputFormat(extension);
    const cacheKey = crypto
      .createHash('sha1')
      .update(`${filePath}:${stats.size}:${stats.mtimeMs}:${width}:${format}`)
      .digest('hex');
    const cacheFile = path.join(CACHE_ROOT, `${cacheKey}.${format}`);

    await ensureDir(CACHE_ROOT);

    if (!(await fileExists(cacheFile))) {
      const tmpFile = `${cacheFile}.tmp`;
      try {
        await generateThumbnail(fullPath, tmpFile, width, format);
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
