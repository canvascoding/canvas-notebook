export type ClientImageFormat = 'jpg' | 'webp' | 'png';

export const IMAGE_PREPROCESS_SIZE_THRESHOLD = 1_500_000;
export const DEFAULT_LARGE_IMAGE_MAX_DIMENSION = 4096;

const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
]);

const HEIC_EXTENSIONS = new Set(['heic', 'heif']);

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
]);

export function getFileExtension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

export function isHeicUploadFile(file: File): boolean {
  if (HEIC_MIME_TYPES.has(file.type.toLowerCase())) return true;
  return HEIC_EXTENSIONS.has(getFileExtension(file));
}

export function isImageUploadFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(getFileExtension(file));
}

export function shouldPreprocessImageFile(file: File): { isHeic: boolean; isLarge: boolean } | null {
  const isHeic = isHeicUploadFile(file);
  const isLarge = isImageUploadFile(file) && file.size > IMAGE_PREPROCESS_SIZE_THRESHOLD;
  return isHeic || isLarge ? { isHeic, isLarge } : null;
}

export function getDefaultImageConvertFormat(file: File, isHeic: boolean): ClientImageFormat {
  if (isHeic) return 'jpg';

  switch (getFileExtension(file)) {
    case 'png':
      return 'png';
    case 'webp':
      return 'webp';
    case 'jpg':
    case 'jpeg':
      return 'jpg';
    default:
      return 'jpg';
  }
}

export function getDefaultImageMaxDimension(isLarge: boolean): number | undefined {
  return isLarge ? DEFAULT_LARGE_IMAGE_MAX_DIMENSION : undefined;
}
