import sharp from 'sharp';

sharp.cache(false);

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
    throw new Error(`Image exceeds maximum buffer size of ${MAX_BUFFER_SIZE / (1024 * 1024)}MB`);
  }

  const release = await conversionSemaphore.acquire();
  try {
    const result = await Promise.race([
      performConversion(buffer, originalName, options),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Image conversion timed out after 30 seconds')),
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

  const srcExt = originalName.toLowerCase().split('.').pop() ?? '';
  const sameFormat =
    (format === 'jpg' && (srcExt === 'jpg' || srcExt === 'jpeg')) ||
    (format === 'webp' && srcExt === 'webp') ||
    (format === 'png' && srcExt === 'png');

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

  if (sameFormat && !needsResize) {
    pipeline = pipeline.withMetadata({ orientation: undefined });
    const outputBuffer = await pipeline.toBuffer();
    return {
      buffer: outputBuffer,
      filename: originalName,
      mimeType: FORMAT_MIME_MAP[format],
      size: outputBuffer.length,
    };
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

  const outputBuffer = await pipeline.toBuffer();
  const filename = replaceExtension(originalName, EXT_MAP[format]);

  return {
    buffer: outputBuffer,
    filename,
    mimeType: FORMAT_MIME_MAP[format],
    size: outputBuffer.length,
  };
}