export const PROVIDERS = [
  { id: 'gemini', labelKey: 'providerOptions.gemini.label' as const },
  { id: 'openai', labelKey: 'providerOptions.openai.label' as const },
] as const;

export const VIDEO_PROVIDERS = [
  { id: 'veo', labelKey: 'Google Veo' as const },
] as const;

export const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-image-preview', optionKey: 'bestQuality' as const },
  { id: 'gemini-2.5-flash-image', optionKey: 'fastAffordable' as const },
] as const;

export const OPENAI_MODELS = [
  { id: 'gpt-image-1.5', optionKey: 'gptImage15' as const },
  { id: 'gpt-image-1', optionKey: 'gptImage1' as const },
  { id: 'gpt-image-1-mini', optionKey: 'gptImage1Mini' as const },
] as const;

export const VIDEO_MODELS = [
  { id: 'veo-3.1-fast-generate-preview', optionKey: 'fast' as const },
  { id: 'veo-3.1-generate-preview', optionKey: 'highQuality' as const },
] as const;

export const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
export const OPENAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'auto'] as const;
export const VIDEO_ASPECT_RATIOS = ['16:9', '9:16'] as const;

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
    return VIDEO_MODELS;
  }
  return provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
}

export function getAspectRatiosForProvider(mode: 'image' | 'video', provider: string) {
  if (mode === 'video') {
    return VIDEO_ASPECT_RATIOS;
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