export const PROVIDERS = [
  { id: 'gemini', labelKey: 'providerOptions.gemini.label' as const },
  { id: 'openai', labelKey: 'providerOptions.openai.label' as const },
] as const;

export const VIDEO_PROVIDERS = [
  { id: 'veo', labelKey: 'Google Veo' as const },
  { id: 'bytedance', labelKey: 'Bytedance Seedance' as const },
] as const;

export const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-image-preview', optionKey: 'bestQuality' as const },
  { id: 'gemini-2.5-flash-image', optionKey: 'fastAffordable' as const },
] as const;

export const OPENAI_MODELS = [
  { id: 'gpt-image-2', optionKey: 'gptImage2' as const },
  { id: 'gpt-image-1.5', optionKey: 'gptImage15' as const },
  { id: 'gpt-image-1', optionKey: 'gptImage1' as const },
  { id: 'gpt-image-1-mini', optionKey: 'gptImage1Mini' as const },
] as const;

export const VIDEO_MODELS = [
  { id: 'veo-3.1-generate-preview', optionKey: 'highQuality' as const },
  { id: 'veo-3.1-fast-generate-preview', optionKey: 'fast' as const },
  { id: 'veo-3.1-lite-generate-preview', optionKey: 'lite' as const },
  { id: 'veo-3.0-generate-001', optionKey: 'veo3' as const },
  { id: 'veo-3.0-fast-generate-001', optionKey: 'veo3Fast' as const },
  { id: 'veo-2.0-generate-001', optionKey: 'veo2' as const },
] as const;

export const SEEDANCE_VIDEO_MODELS = [
  { id: 'bytedance/seedance-2', optionKey: 'seedance2' as const },
] as const;

export type VideoModelId = (typeof VIDEO_MODELS)[number]['id'];
export type SeedanceVideoModelId = (typeof SEEDANCE_VIDEO_MODELS)[number]['id'];

export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16'] as const;
export const SEEDANCE_VIDEO_ASPECT_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'adaptive'] as const;
export const VIDEO_RESOLUTIONS = ['720p', '1080p', '4k'] as const;
export const SEEDANCE_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export const VIDEO_DURATIONS = [4, 5, 6, 8] as const;
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
  'veo-3.0-generate-001': {
    extension: true,
    references: false,
    firstLastFrame: true,
    resolutions: ['720p', '1080p'],
    durations: [8],
    audio: true,
    personGeneration: ['allow_all', 'allow_adult'],
  },
  'veo-3.0-fast-generate-001': {
    extension: true,
    references: false,
    firstLastFrame: true,
    resolutions: ['720p', '1080p'],
    durations: [8],
    audio: true,
    personGeneration: ['allow_all', 'allow_adult'],
  },
  'veo-2.0-generate-001': {
    extension: false,
    references: false,
    firstLastFrame: true,
    resolutions: ['720p'],
    durations: [5, 6, 8],
    audio: false,
    personGeneration: ['allow_all', 'allow_adult', 'dont_allow'],
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

export const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const;
export const OUTPUT_FORMAT_OPTIONS = ['png', 'jpeg', 'webp'] as const;
export const BACKGROUND_OPTIONS = ['auto', 'opaque', 'transparent'] as const;

export const GEMINI_MAX_IMAGE_COUNT = 4;
export const OPENAI_MAX_IMAGE_COUNT = 10;
export const OPENAI_MAX_REFERENCE_IMAGES = 16;

export function getProvidersForMode(mode: 'image' | 'video') {
  return mode === 'video' ? VIDEO_PROVIDERS : PROVIDERS;
}

export function getModelsForProvider(mode: 'image' | 'video', provider: string) {
  if (mode === 'video') {
    return provider === 'bytedance' ? SEEDANCE_VIDEO_MODELS : VIDEO_MODELS;
  }
  return provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
}

export function getAspectRatiosForProvider(mode: 'image' | 'video', provider: string) {
  if (mode === 'video') {
    return provider === 'bytedance' ? SEEDANCE_VIDEO_ASPECT_RATIOS : VIDEO_ASPECT_RATIOS;
  }
  return provider === 'openai' ? OPENAI_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS;
}

export function getMaxImageCountForProvider(mode: 'image' | 'video', provider: string) {
  if (mode === 'video') {
    return 1;
  }
  return provider === 'openai' ? OPENAI_MAX_IMAGE_COUNT : GEMINI_MAX_IMAGE_COUNT;
}

export function getMaxReferenceImages(mode: 'image' | 'video', provider: string, model: string): number {
  if (mode === 'video') {
    return 0;
  }
  if (provider === 'openai') {
    return OPENAI_MAX_REFERENCE_IMAGES;
  }
  if (model === 'gemini-2.5-flash-image') {
    return 3;
  }
  return 14;
}

export function getDefaultModelForProvider(mode: 'image' | 'video', provider: string): string {
  const models = getModelsForProvider(mode, provider);
  return models[0]?.id ?? 'gemini-3.1-flash-image-preview';
}
