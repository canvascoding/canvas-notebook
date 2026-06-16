import type { StudioGenerationMode } from '../types/generation';
import {
  SEEDANCE_MAX_REFERENCE_IMAGES,
  SOUND_MAX_REFERENCE_FILES,
  VEO_MAX_REFERENCE_IMAGES,
} from '@/app/lib/integrations/image-generation-constants';

export const DEFAULT_IMAGE_REFERENCE_LIMIT = SEEDANCE_MAX_REFERENCE_IMAGES;

export function getVideoImageReferenceLimit(provider?: string): number {
  if (provider === 'veo') return VEO_MAX_REFERENCE_IMAGES;
  if (provider === 'bytedance') return SEEDANCE_MAX_REFERENCE_IMAGES;
  return DEFAULT_IMAGE_REFERENCE_LIMIT;
}

export function getFileReferenceLimitForMode(mode: StudioGenerationMode, provider?: string): number | undefined {
  if (mode === 'sound') return SOUND_MAX_REFERENCE_FILES;
  if (mode === 'video') return getVideoImageReferenceLimit(provider);
  return undefined;
}
