import {
  getDefaultOpenAIImageSize,
  getOpenAIImageModelCapabilities,
  getOpenAIImageRequestValidationError,
  normalizeOpenAIImageOutputFormat,
  normalizeOpenAIImageSizeInput,
  type OpenAIImageBackground,
  type OpenAIImageModeration,
  type OpenAIImageOutputFormat,
  type OpenAIImageQuality,
  type OpenAIImageRequestOptions,
} from './image-generation-constants';

export function normalizeOpenAIImageRequestOptions(options: OpenAIImageRequestOptions & { model: string; aspectRatio?: string }) {
  const validCompression = typeof options.outputCompression === 'number'
    && Number.isInteger(options.outputCompression) && options.outputCompression >= 0 && options.outputCompression <= 100;
  const validationError = getOpenAIImageRequestValidationError({
    ...options,
    ...(options.outputFormat !== 'jpeg' && options.outputFormat !== 'webp' && validCompression ? { outputCompression: undefined } : {}),
  });
  if (validationError) throw new Error(validationError);
  const capabilities = getOpenAIImageModelCapabilities(options.model);
  if (!capabilities) throw new Error(`Unsupported OpenAI image model: ${options.model}`);
  const background = (options.background ?? 'auto') as OpenAIImageBackground;
  const outputFormat = normalizeOpenAIImageOutputFormat(background, options.outputFormat as OpenAIImageOutputFormat | undefined) ?? 'png';
  const outputCompression = outputFormat === 'jpeg' || outputFormat === 'webp' ? options.outputCompression as number | undefined : undefined;
  const imageSize = normalizeOpenAIImageSizeInput((options.imageSize as string | undefined) || getDefaultOpenAIImageSize(options.aspectRatio ?? '1:1'));
  const stream = options.stream === true;
  return {
    model: capabilities.modelId,
    quality: (options.quality ?? 'auto') as OpenAIImageQuality,
    outputFormat,
    background,
    moderation: (options.moderation ?? 'auto') as OpenAIImageModeration,
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    imageSize,
    stream,
    ...(stream ? { partialImages: (options.partialImages as number | undefined) ?? 0 } : {}),
  };
}
