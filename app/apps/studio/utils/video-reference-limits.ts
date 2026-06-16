import type { StudioGenerationMode } from '../types/generation';
import {
  SEEDANCE_MAX_REFERENCE_IMAGES,
  SOUND_MAX_REFERENCE_FILES,
  VEO_MAX_REFERENCE_IMAGES,
} from '@/app/lib/integrations/image-generation-constants';

export const DEFAULT_IMAGE_REFERENCE_LIMIT = SEEDANCE_MAX_REFERENCE_IMAGES;

export interface ImageReferenceBudgetRef {
  imageCount?: number | null;
}

export interface VideoImageReferenceBudgetInput {
  mode: StudioGenerationMode;
  provider?: string;
  productRefs?: readonly ImageReferenceBudgetRef[];
  personaRefs?: readonly ImageReferenceBudgetRef[];
  styleRefs?: readonly ImageReferenceBudgetRef[];
  fileRefs?: readonly ImageReferenceBudgetRef[];
}

export interface VideoImageReferenceBudget {
  limit: number;
  objectImageCount: number;
  fileImageCount: number;
  acceptedFileCount: number;
  droppedObjectImageCount: number;
  droppedFileCount: number;
  used: number;
  remaining: number;
}

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

function getObjectReferenceImageCount(ref: ImageReferenceBudgetRef): number {
  if (typeof ref.imageCount !== 'number' || !Number.isFinite(ref.imageCount)) {
    return 1;
  }
  return Math.max(0, Math.floor(ref.imageCount));
}

function countObjectReferenceImages(refs: readonly ImageReferenceBudgetRef[] = []): number {
  return refs.reduce((sum, ref) => sum + getObjectReferenceImageCount(ref), 0);
}

export function getVideoImageReferenceBudget(input: VideoImageReferenceBudgetInput): VideoImageReferenceBudget {
  const limit = getVideoImageReferenceLimit(input.provider);
  const objectImageCount = countObjectReferenceImages(input.productRefs)
    + countObjectReferenceImages(input.personaRefs)
    + countObjectReferenceImages(input.styleRefs);
  const fileImageCount = input.fileRefs?.length ?? 0;
  const acceptedFileCount = Math.min(fileImageCount, Math.max(limit - objectImageCount, 0));
  const droppedObjectImageCount = Math.max(objectImageCount - limit, 0);
  const droppedFileCount = Math.max(fileImageCount - acceptedFileCount, 0);
  const used = Math.min(limit, objectImageCount + acceptedFileCount);
  const remaining = Math.max(limit - objectImageCount - acceptedFileCount, 0);

  return {
    limit,
    objectImageCount,
    fileImageCount,
    acceptedFileCount,
    droppedObjectImageCount,
    droppedFileCount,
    used,
    remaining,
  };
}

export function getAcceptedFileReferenceCountForMode(input: VideoImageReferenceBudgetInput): number | undefined {
  const fileImageCount = input.fileRefs?.length ?? 0;

  if (input.mode === 'sound') {
    return Math.min(fileImageCount, SOUND_MAX_REFERENCE_FILES);
  }

  if (input.mode === 'video') {
    return getVideoImageReferenceBudget(input).acceptedFileCount;
  }

  return undefined;
}
