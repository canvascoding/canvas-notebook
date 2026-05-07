import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

sharp.cache(false);

const execFileAsync = promisify(execFile);

export interface ConvertOptions {
  format: 'jpg' | 'webp' | 'png';
  quality?: number;
  maxDimension?: number;
}

export interface ConvertResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
}

type ImageConversionErrorCode =
  | 'buffer_too_large'
  | 'timeout'
  | 'unsupported_heic'
  | 'corrupt_image';

export class ImageConversionError extends Error {
  code: ImageConversionErrorCode;

  constructor(code: ImageConversionErrorCode, message: string) {
    super(message);
    this.name = 'ImageConversionError';
    this.code = code;
  }
}

const MAX_BUFFER_SIZE = 50 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 30_000;

const FORMAT_MIME_MAP: Record<ConvertOptions['format'], string> = {
  jpg: 'image/jpeg',
  webp: 'image/webp',
  png: 'image/png',
};

const EXT_MAP: Record<ConvertOptions['format'], string> = {
  jpg: '.jpg',
  webp: '.webp',
  png: '.png',
};

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
]);

const SHARP_HEIC_UNSUPPORTED_PATTERNS = [
  'support for this compression format has not been built in',
  'heif: error while loading plugin',
  'source: bad seek',
];

type SemaphoreCallback = () => Promise<void>;

class Semaphore {
  private queue: SemaphoreCallback[] = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const run = async () => {
        this.running++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.running--;
          if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
          }
        };
        resolve(release);
      };

      if (this.running < this.max) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
}

const conversionSemaphore = new Semaphore(1);

function replaceExtension(filename: string, newExt: string): string {
  const lastDot = filename.lastIndexOf('.');
  const baseName = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  return baseName + newExt;
}

export function isHeicMimeType(mimeType: string): boolean {
  return HEIC_MIME_TYPES.has(mimeType.toLowerCase());
}

export function isHeicExtension(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return ext === 'heic' || ext === 'heif';
}

export function isHeicFile(filename: string, mimeType?: string): boolean {
  if (mimeType && isHeicMimeType(mimeType)) return true;
  return isHeicExtension(filename);
}

export async function convertImage(
  buffer: Buffer,
  originalName: string,
  options: ConvertOptions,
): Promise<ConvertResult> {
  if (buffer.length > MAX_BUFFER_SIZE) {
    throw new ImageConversionError(
      'buffer_too_large',
      `Image exceeds maximum buffer size of ${MAX_BUFFER_SIZE / (1024 * 1024)}MB`,
    );
  }

  const release = await conversionSemaphore.acquire();
  try {
    const result = await Promise.race([
      performConversion(buffer, originalName, options),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ImageConversionError('timeout', 'Image conversion timed out after 30 seconds')),
          CONVERSION_TIMEOUT_MS,
        ),
      ),
    ]);
    return result;
  } finally {
    release();
  }
}

async function performConversion(
  buffer: Buffer,
  originalName: string,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const { format, quality = 80, maxDimension } = options;
  const sourceIsHeic = isHeicExtension(originalName);

  let pipeline = sharp(buffer, { limitInputPixels: false }).rotate();

  const needsResize = maxDimension !== undefined && maxDimension > 0;

  if (needsResize) {
    pipeline = pipeline.resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  pipeline = pipeline.withMetadata({ orientation: undefined });

  switch (format) {
    case 'jpg':
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 6 });
      break;
  }

  let outputBuffer: Buffer;
  try {
    outputBuffer = await pipeline.toBuffer();
  } catch (error) {
    if (sourceIsHeic && isSharpHeicUnsupportedError(error)) {
      const decoded = await decodeHeicWithSystemFallback(buffer, originalName);
      return performConversion(decoded.buffer, decoded.filename, options);
    }

    if (error instanceof ImageConversionError) {
      throw error;
    }

    throw new ImageConversionError(
      'corrupt_image',
      error instanceof Error ? error.message : 'Image conversion failed',
    );
  }
  const filename = replaceExtension(originalName, EXT_MAP[format]);

  return {
    buffer: outputBuffer,
    filename,
    mimeType: FORMAT_MIME_MAP[format],
    size: outputBuffer.length,
  };
}

function isSharpHeicUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return SHARP_HEIC_UNSUPPORTED_PATTERNS.some((pattern) => message.includes(pattern));
}

async function decodeHeicWithSystemFallback(
  buffer: Buffer,
  originalName: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-heic-'));
  const inputPath = path.join(tempDir, replaceExtension(path.basename(originalName), '.heic'));
  const outputPath = path.join(tempDir, replaceExtension(path.basename(originalName), '.png'));

  try {
    await fs.writeFile(inputPath, buffer);

    if (process.platform === 'darwin') {
      await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', inputPath, '--out', outputPath]);
    } else {
      await execFileAsync('heif-convert', [inputPath, outputPath]);
    }

    const decodedBuffer = await fs.readFile(outputPath);
    return {
      buffer: decodedBuffer,
      filename: replaceExtension(originalName, '.png'),
    };
  } catch (error) {
    throw new ImageConversionError(
      'unsupported_heic',
      error instanceof Error
        ? `HEIC conversion is not available on this server: ${error.message}`
        : 'HEIC conversion is not available on this server',
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function getImageConversionErrorMessage(fileName: string, error: unknown): string {
  if (error instanceof ImageConversionError) {
    switch (error.code) {
      case 'buffer_too_large':
        return `${fileName}: Image exceeds the 50 MB conversion limit`;
      case 'timeout':
        return `${fileName}: Image conversion timed out`;
      case 'unsupported_heic':
        return `${fileName}: HEIC conversion is not available on this server right now`;
      case 'corrupt_image':
        return `${fileName}: Image conversion failed — file may be corrupt`;
    }
  }

  return `${fileName}: Image conversion failed`;
}
