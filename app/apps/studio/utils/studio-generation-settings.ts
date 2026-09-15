import type { StudioGeneration } from '../types/generation';
import {
  getDefaultOpenAIImageSize,
  getOpenAIImageAspectRatio,
  isValidOpenAIImageSize,
  normalizeOpenAIImageSizeInput,
} from '@/app/lib/integrations/image-generation-constants';

function readGenerationMetadata(generation: StudioGeneration): Record<string, unknown> {
  if (!generation.metadata) return {};
  try {
    const parsed: unknown = JSON.parse(generation.metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function getStudioGenerationImageFormat(generation: StudioGeneration): {
  aspectRatio: string;
  imageSize: string | undefined;
} {
  const fallbackAspectRatio = generation.aspectRatio || '1:1';
  if (generation.provider !== 'openai' || generation.mode !== 'image') {
    return { aspectRatio: fallbackAspectRatio, imageSize: undefined };
  }

  const metadata = readGenerationMetadata(generation);
  const storedImageSize = typeof metadata.imageSize === 'string'
    ? normalizeOpenAIImageSizeInput(metadata.imageSize)
    : getDefaultOpenAIImageSize(fallbackAspectRatio);
  const imageSize = isValidOpenAIImageSize(storedImageSize)
    ? storedImageSize
    : getDefaultOpenAIImageSize(fallbackAspectRatio);
  return {
    imageSize,
    aspectRatio: getOpenAIImageAspectRatio(imageSize, fallbackAspectRatio),
  };
}
