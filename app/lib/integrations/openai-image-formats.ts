export const OPENAI_IMAGE_SIZE_LIMITS = {
  multipleOf: 16,
  minimumPixels: 655_360,
  maximumPixels: 8_294_400,
  maximumEdge: 3_840,
  maximumAspectRatio: 3,
} as const;

export const OPENAI_RECOMMENDED_IMAGE_SIZES = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
] as const;

export const OPENAI_ASPECT_RATIOS = [
  '1:1',
  '3:2',
  '2:3',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '4:5',
  'auto',
] as const;

export type OpenAIImageFormatPresetId =
  | 'auto'
  | 'square'
  | 'landscape-3-2'
  | 'portrait-2-3'
  | 'widescreen-16-9'
  | 'portrait-9-16'
  | 'landscape-4-3'
  | 'portrait-3-4'
  | 'portrait-4-5';

export interface OpenAIImageFormatPreset {
  id: OpenAIImageFormatPresetId;
  aspectRatio: (typeof OPENAI_ASPECT_RATIOS)[number];
  size: string;
  width: number | null;
  height: number | null;
}

export const OPENAI_IMAGE_FORMAT_PRESETS: readonly OpenAIImageFormatPreset[] = [
  { id: 'auto', aspectRatio: 'auto', size: 'auto', width: null, height: null },
  { id: 'square', aspectRatio: '1:1', size: '1024x1024', width: 1024, height: 1024 },
  { id: 'landscape-3-2', aspectRatio: '3:2', size: '1536x1024', width: 1536, height: 1024 },
  { id: 'portrait-2-3', aspectRatio: '2:3', size: '1024x1536', width: 1024, height: 1536 },
  { id: 'widescreen-16-9', aspectRatio: '16:9', size: '1536x864', width: 1536, height: 864 },
  { id: 'portrait-9-16', aspectRatio: '9:16', size: '864x1536', width: 864, height: 1536 },
  { id: 'landscape-4-3', aspectRatio: '4:3', size: '1344x1008', width: 1344, height: 1008 },
  { id: 'portrait-3-4', aspectRatio: '3:4', size: '1008x1344', width: 1008, height: 1344 },
  { id: 'portrait-4-5', aspectRatio: '4:5', size: '1024x1280', width: 1024, height: 1280 },
];

const OPENAI_IMAGE_SIZE_BY_ASPECT_RATIO = Object.fromEntries(
  OPENAI_IMAGE_FORMAT_PRESETS.map((preset) => [preset.aspectRatio, preset.size]),
) as Record<string, string>;

export type OpenAIImageSizeValidationCode =
  | 'format'
  | 'multipleOf'
  | 'maximumEdge'
  | 'aspectRatio'
  | 'pixelCount';

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

export function normalizeOpenAIImageSizeInput(size: string): string {
  const trimmed = size.trim();
  if (trimmed.toLowerCase() === 'auto') return 'auto';

  const match = /^(\d+)\s*[x×]\s*(\d+)$/iu.exec(trimmed);
  if (!match) return trimmed.toLowerCase();
  return `${Number(match[1])}x${Number(match[2])}`;
}

export function parseOpenAIImageSize(size: string): { width: number; height: number } | null {
  const normalized = normalizeOpenAIImageSizeInput(size);
  const match = /^(\d+)x(\d+)$/u.exec(normalized);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function getOpenAIImageAspectRatio(size: string, fallback = '1:1'): string {
  const normalized = normalizeOpenAIImageSizeInput(size);
  if (normalized === 'auto') return 'auto';
  const dimensions = parseOpenAIImageSize(normalized);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return fallback;
  const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
  return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

export function getDefaultOpenAIImageSize(aspectRatio: string): string {
  return OPENAI_IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio] ?? '1024x1024';
}

export function getOpenAIImageFormatPreset(size: string): OpenAIImageFormatPreset | null {
  const normalized = normalizeOpenAIImageSizeInput(size);
  return OPENAI_IMAGE_FORMAT_PRESETS.find((preset) => preset.size === normalized) ?? null;
}

export function getOpenAIImageSizeValidationCode(size: string): OpenAIImageSizeValidationCode | null {
  const normalized = normalizeOpenAIImageSizeInput(size);
  if (normalized === 'auto') return null;

  const dimensions = parseOpenAIImageSize(normalized);
  if (!dimensions) return 'format';
  const { width, height } = dimensions;
  if (width % OPENAI_IMAGE_SIZE_LIMITS.multipleOf !== 0 || height % OPENAI_IMAGE_SIZE_LIMITS.multipleOf !== 0) {
    return 'multipleOf';
  }
  if (width > OPENAI_IMAGE_SIZE_LIMITS.maximumEdge || height > OPENAI_IMAGE_SIZE_LIMITS.maximumEdge) {
    return 'maximumEdge';
  }

  const ratio = Math.max(width, height) / Math.min(width, height);
  if (!Number.isFinite(ratio) || ratio > OPENAI_IMAGE_SIZE_LIMITS.maximumAspectRatio) {
    return 'aspectRatio';
  }

  const pixels = width * height;
  if (pixels < OPENAI_IMAGE_SIZE_LIMITS.minimumPixels || pixels > OPENAI_IMAGE_SIZE_LIMITS.maximumPixels) {
    return 'pixelCount';
  }
  return null;
}

const OPENAI_IMAGE_SIZE_VALIDATION_MESSAGES: Record<OpenAIImageSizeValidationCode, string> = {
  format: 'Use auto or WIDTHxHEIGHT, for example 1536x864.',
  multipleOf: 'Width and height must be divisible by 16.',
  maximumEdge: 'Neither edge may exceed 3840 pixels.',
  aspectRatio: 'The aspect ratio must be between 1:3 and 3:1.',
  pixelCount: 'The total pixel count must be between 655,360 and 8,294,400.',
};

export function getOpenAIImageSizeValidationError(size: string): string | null {
  const code = getOpenAIImageSizeValidationCode(size);
  return code ? OPENAI_IMAGE_SIZE_VALIDATION_MESSAGES[code] : null;
}

export function isValidOpenAIImageSize(size: string): boolean {
  return getOpenAIImageSizeValidationCode(size) === null;
}
