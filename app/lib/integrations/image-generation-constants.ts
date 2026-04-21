export const PROVIDERS = [
  { id: 'gemini', labelKey: 'providerOptions.gemini.label' as const },
  { id: 'openai', labelKey: 'providerOptions.openai.label' as const },
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

export const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
export const OPENAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'auto'] as const;

export const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const;
export const OUTPUT_FORMAT_OPTIONS = ['png', 'jpeg', 'webp'] as const;
export const BACKGROUND_OPTIONS = ['auto', 'opaque', 'transparent'] as const;

export const GEMINI_MAX_IMAGE_COUNT = 4;
export const OPENAI_MAX_IMAGE_COUNT = 10;
export const OPENAI_MAX_REFERENCE_IMAGES = 16;

export function getModelsForProvider(provider: string) {
  return provider === 'openai' ? OPENAI_MODELS : GEMINI_MODELS;
}

export function getAspectRatiosForProvider(provider: string) {
  return provider === 'openai' ? OPENAI_ASPECT_RATIOS : GEMINI_ASPECT_RATIOS;
}

export function getMaxImageCountForProvider(provider: string) {
  return provider === 'openai' ? OPENAI_MAX_IMAGE_COUNT : GEMINI_MAX_IMAGE_COUNT;
}

export function getMaxReferenceImages(provider: string, model: string): number {
  if (provider === 'openai') {
    return OPENAI_MAX_REFERENCE_IMAGES;
  }
  if (model === 'gemini-2.5-flash-image') {
    return 3;
  }
  return 14;
}

export function getDefaultModelForProvider(provider: string): string {
  const models = getModelsForProvider(provider);
  return models[0]?.id ?? 'gemini-3.1-flash-image-preview';
}