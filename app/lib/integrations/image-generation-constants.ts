export const PROVIDERS = [
  { id: 'gemini', labelKey: 'providerOptions.gemini.label' as const },
  { id: 'openai', labelKey: 'providerOptions.openai.label' as const },
] as const;

export const VIDEO_PROVIDERS = [
  { id: 'veo', labelKey: 'Google Veo' as const },
  { id: 'bytedance', labelKey: 'Bytedance' as const },
] as const;

export const SOUND_PROVIDERS = [
  { id: 'gemini', labelKey: 'Google Gemini' as const },
] as const;

export const GEMINI_FLASH_IMAGE_MODEL_ID = 'gemini-3.1-flash-image';
export const GEMINI_PRO_IMAGE_MODEL_ID = 'gemini-3-pro-image';
export const GEMINI_LEGACY_IMAGE_MODEL_ALIASES: Record<string, string> = {
  'gemini-3.1-flash-image-preview': GEMINI_FLASH_IMAGE_MODEL_ID,
  'gemini-3-pro-image-preview': GEMINI_PRO_IMAGE_MODEL_ID,
  'gemini-3.1-pro-image': GEMINI_PRO_IMAGE_MODEL_ID,
  'gemini-3.1-pro-image-preview': GEMINI_PRO_IMAGE_MODEL_ID,
  'gemini-2.5-flash-image': GEMINI_FLASH_IMAGE_MODEL_ID,
  'gemini-2.5-flash-image-preview': GEMINI_FLASH_IMAGE_MODEL_ID,
  'gemini-2.0-flash-preview-image-generation': GEMINI_FLASH_IMAGE_MODEL_ID,
  'gemini-2.0-flash-exp-image-generation': GEMINI_FLASH_IMAGE_MODEL_ID,
};

export function normalizeGeminiImageModelId(model: string): string {
  const trimmed = model.trim();
  return GEMINI_LEGACY_IMAGE_MODEL_ALIASES[trimmed] ?? trimmed;
}

export const GEMINI_MODELS = [
  { id: GEMINI_FLASH_IMAGE_MODEL_ID, optionKey: 'bestQuality' as const },
  { id: GEMINI_PRO_IMAGE_MODEL_ID, optionKey: 'proQuality' as const },
] as const;

export const GEMINI_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export const GEMINI_FLASH_IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const;

export function getImageSizesForModel(model: string): readonly string[] {
  const normalizedModel = normalizeGeminiImageModelId(model);
  if (normalizedModel === GEMINI_FLASH_IMAGE_MODEL_ID) return GEMINI_FLASH_IMAGE_SIZES;
  return GEMINI_IMAGE_SIZES;
}

export const OPENAI_IMAGE_MODEL_ID = 'gpt-image-2.5-sunburst';
export const OPENAI_LEGACY_IMAGE_MODEL_ALIASES: Record<string, string> = {
  'gpt-image-2': OPENAI_IMAGE_MODEL_ID,
  'gpt-image-2-2026-04-21': OPENAI_IMAGE_MODEL_ID,
};

export function normalizeOpenAIImageModelId(model: string): string {
  const trimmed = model.trim();
  return OPENAI_LEGACY_IMAGE_MODEL_ALIASES[trimmed] ?? trimmed;
}

export const OPENAI_MODELS = [
  { id: OPENAI_IMAGE_MODEL_ID, optionKey: 'gptImage25Sunburst' as const },
] as const;

export const VIDEO_MODELS = [
  { id: 'veo-3.1-generate-preview', optionKey: 'highQuality' as const },
  { id: 'veo-3.1-fast-generate-preview', optionKey: 'fast' as const },
  { id: 'veo-3.1-lite-generate-preview', optionKey: 'lite' as const },
] as const;

export const SEEDANCE_VIDEO_MODELS = [
  { id: 'bytedance/seedance-2', optionKey: 'seedance2' as const },
] as const;

export const SOUND_MODELS = [
  { id: 'lyria-3-clip-preview', optionKey: 'clip' as const },
  { id: 'lyria-3-pro-preview', optionKey: 'pro' as const },
] as const;

export type VideoModelId = (typeof VIDEO_MODELS)[number]['id'];
export type SeedanceVideoModelId = (typeof SEEDANCE_VIDEO_MODELS)[number]['id'];
export type SoundModelId = (typeof SOUND_MODELS)[number]['id'];

export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16'] as const;
export const SEEDANCE_VIDEO_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'adaptive'] as const;
export const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k'] as const;
export const SEEDANCE_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export const VIDEO_DURATIONS = [4, 6, 8] as const;
export const SEEDANCE_VIDEO_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];
export type SeedanceVideoDuration = (typeof SEEDANCE_VIDEO_DURATIONS)[number];
export type StudioVideoDuration = VideoDuration | SeedanceVideoDuration;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number] | (typeof SEEDANCE_VIDEO_RESOLUTIONS)[number];

export interface VideoModelCapabilities {
  extension: boolean;
  references: boolean;
  firstLastFrame: boolean;
  resolutions: readonly VideoResolution[];
  durations: readonly VideoDuration[];
  audio: boolean;
  personGeneration: readonly ('allow_all' | 'allow_adult' | 'dont_allow')[];
}

export const VEO_MODEL_CAPABILITIES: Record<VideoModelId, VideoModelCapabilities> = {
  'veo-3.1-generate-preview': {
    extension: true,
    references: true,
    firstLastFrame: true,
    resolutions: ['720p', '1080p', '4k'],
    durations: [4, 6, 8],
    audio: true,
    personGeneration: ['allow_all', 'allow_adult'],
  },
  'veo-3.1-fast-generate-preview': {
    extension: true,
    references: true,
    firstLastFrame: true,
    resolutions: ['720p', '1080p', '4k'],
    durations: [4, 6, 8],
    audio: true,
    personGeneration: ['allow_all', 'allow_adult'],
  },
  'veo-3.1-lite-generate-preview': {
    extension: false,
    references: false,
    firstLastFrame: true,
    resolutions: ['720p', '1080p'],
    durations: [4, 6, 8],
    audio: true,
    personGeneration: ['allow_all', 'allow_adult'],
  },
};

export function getVideoModelCapabilities(modelId: string): VideoModelCapabilities {
  return VEO_MODEL_CAPABILITIES[modelId as VideoModelId] ?? VEO_MODEL_CAPABILITIES['veo-3.1-fast-generate-preview'];
}

export function getVideoResolutionsForModel(modelId: string): readonly VideoResolution[] {
  if (modelId === 'bytedance/seedance-2') {
    return SEEDANCE_VIDEO_RESOLUTIONS;
  }
  return getVideoModelCapabilities(modelId).resolutions;
}

export function getVideoDurationsForModel(modelId: string): readonly StudioVideoDuration[] {
  if (modelId === 'bytedance/seedance-2') {
    return SEEDANCE_VIDEO_DURATIONS;
  }
  return getVideoModelCapabilities(modelId).durations;
}

export const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
export const OPENAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'auto'] as const;

export const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const OUTPUT_FORMAT_OPTIONS = ['png', 'jpeg', 'webp'] as const;
export const BACKGROUND_OPTIONS = ['auto', 'opaque', 'transparent'] as const;
export const OPENAI_MODERATION_OPTIONS = ['auto', 'low'] as const;
export const OPENAI_INPUT_FIDELITY_OPTIONS = ['low', 'high'] as const;
export const OPENAI_RECOMMENDED_IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;

export type OpenAIImageQuality = (typeof QUALITY_OPTIONS)[number];
export type OpenAIImageOutputFormat = (typeof OUTPUT_FORMAT_OPTIONS)[number];
export type OpenAIImageBackground = (typeof BACKGROUND_OPTIONS)[number];
export type OpenAIImageModeration = (typeof OPENAI_MODERATION_OPTIONS)[number];
export type OpenAIImageInputFidelity = (typeof OPENAI_INPUT_FIDELITY_OPTIONS)[number];

const OPENAI_IMAGE_SIZE_BY_ASPECT_RATIO: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '4:3': '1344x1008',
  '3:4': '1008x1344',
  auto: 'auto',
};

export function getDefaultOpenAIImageSize(aspectRatio: string): string {
  return OPENAI_IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio] ?? '1024x1024';
}

export function getOpenAIImageSizeValidationError(size: string): string | null {
  const normalized = size.trim().toLowerCase();
  if (normalized === 'auto') return null;

  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) {
    return 'Use auto or WIDTHxHEIGHT, for example 1536x864.';
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 16 !== 0 || height % 16 !== 0) {
    return 'Width and height must be divisible by 16.';
  }
  if (width > 3840 || height > 3840) {
    return 'Neither edge may exceed 3840 pixels.';
  }

  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > 3) {
    return 'The aspect ratio must be between 1:3 and 3:1.';
  }

  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) {
    return 'The total pixel count must be between 655,360 and 8,294,400.';
  }

  return null;
}

export function isValidOpenAIImageSize(size: string): boolean {
  return getOpenAIImageSizeValidationError(size) === null;
}

/** OpenAI only supports transparent backgrounds with PNG or WebP output. */
export function normalizeOpenAIImageOutputFormat(
  background: (typeof BACKGROUND_OPTIONS)[number] | undefined,
  outputFormat: (typeof OUTPUT_FORMAT_OPTIONS)[number] | undefined,
) {
  return background === 'transparent' && outputFormat === 'jpeg' ? 'png' : outputFormat;
}

export const GEMINI_MAX_IMAGE_COUNT = 4;
export const OPENAI_MAX_IMAGE_COUNT = 10;
export const OPENAI_MAX_REFERENCE_IMAGES = 16;
export const VEO_MAX_REFERENCE_IMAGES = 3;
export const SEEDANCE_MAX_REFERENCE_IMAGES = 9;
export const SOUND_MAX_REFERENCE_FILES = 10;

export function getProvidersForMode(mode: 'image' | 'video' | 'sound') {
  if (mode === 'sound') return SOUND_PROVIDERS;
  return mode === 'video' ? VIDEO_PROVIDERS : PROVIDERS;
}

export function getModelsForProvider(mode: 'image' | 'video' | 'sound', provider: string) {
  if (mode === 'sound') {
    return SOUND_MODELS;
  }
  if (mode === 'video') {
    return provider === 'bytedance' ? SEEDANCE_VIDEO_MODELS : VIDEO_MODELS;
  }
  return provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
}

export function getAspectRatiosForProvider(mode: 'image' | 'video' | 'sound', provider: string) {
  if (mode === 'sound') {
    return [];
  }
  if (mode === 'video') {
    return provider === 'bytedance' ? SEEDANCE_VIDEO_ASPECT_RATIOS : VIDEO_ASPECT_RATIOS;
  }
  return provider === 'openai' ? OPENAI_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS;
}

export function getMaxImageCountForProvider(mode: 'image' | 'video' | 'sound', provider: string) {
  if (mode === 'video' || mode === 'sound') {
    return 1;
  }
  return provider === 'openai' ? OPENAI_MAX_IMAGE_COUNT : GEMINI_MAX_IMAGE_COUNT;
}

export function getMaxReferenceImages(mode: 'image' | 'video' | 'sound', provider: string, _model: string): number {
  if (mode === 'sound') {
    return 10;
  }
  if (mode === 'video') {
    return 0;
  }
  if (provider === 'openai') {
    return OPENAI_MAX_REFERENCE_IMAGES;
  }
  return 14;
}

export function getDefaultModelForProvider(mode: 'image' | 'video' | 'sound', provider: string): string {
  const models = getModelsForProvider(mode, provider);
  return models[0]?.id ?? GEMINI_FLASH_IMAGE_MODEL_ID;
}
