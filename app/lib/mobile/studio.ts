import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  getFileStats,
  readFile,
  type WorkspaceFileOperationOptions,
} from '@/app/lib/filesystem/workspace-files';
import {
  BACKGROUND_OPTIONS,
  getAspectRatiosForProvider,
  getDefaultModelForProvider,
  getImageSizesForModel,
  getMaxImageCountForProvider,
  getModelsForProvider,
  getVideoDurationsForModel,
  getVideoResolutionsForModel,
  QUALITY_OPTIONS,
} from '@/app/lib/integrations/image-generation-constants';
import { getStudioProviderConfig } from '@/app/lib/integrations/studio-config';
import {
  getStudioGeneration,
  getStudioOutputForUser,
  listStudioGenerations,
  type StudioGenerateRequest,
} from '@/app/lib/integrations/studio-generation-service';
import { listPersonas } from '@/app/lib/integrations/studio-persona-service';
import { listPresets } from '@/app/lib/integrations/studio-preset-service';
import { listProducts } from '@/app/lib/integrations/studio-product-service';
import type { StudioScope } from '@/app/lib/integrations/studio-scope';
import { STUDIO_STARTING_POINTS } from '@/app/lib/integrations/studio-starting-points';
import { listStyles } from '@/app/lib/integrations/studio-style-service';
import {
  generateStudioReferencePath,
  writeAssetFile,
} from '@/app/lib/integrations/studio-workspace';
import { normalizeMobileFilePath } from '@/app/lib/mobile/files';
import { getPublicShareMimeType } from '@/app/lib/public-sharing/public-file-shares';

const MAX_LIST_LIMIT = 50;
const MAX_REFERENCE_COUNT = 16;
const MAX_IMAGE_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_REFERENCE_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_REFERENCE_BYTES = 15 * 1024 * 1024;

const MODE_PROVIDERS = {
  image: ['gemini', 'openai'],
  video: ['veo', 'bytedance'],
  sound: ['gemini'],
} as const;

type MobileStudioMode = keyof typeof MODE_PROVIDERS;
type MobileStudioReferenceKind = 'image' | 'video' | 'audio';

type MobileStudioReference = {
  kind: MobileStudioReferenceKind;
  path: string;
};

export class MobileStudioError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'MobileStudioError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string, maximumLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new MobileStudioError(`${field} is invalid.`, 400, 'INVALID_STUDIO_REQUEST');
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new MobileStudioError(`${field} is invalid.`, 400, 'INVALID_STUDIO_REQUEST');
  }
  return normalized;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new MobileStudioError(`${field} is not supported.`, 400, 'UNSUPPORTED_STUDIO_OPTION');
  }
  return value as T;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new MobileStudioError('A Studio option is invalid.', 400, 'INVALID_STUDIO_REQUEST');
  }
  return value;
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new MobileStudioError(`${field} is invalid.`, 400, 'INVALID_STUDIO_REQUEST');
  }
  return Number(value);
}

function identifierArray(value: unknown, field: string, maximumItems: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new MobileStudioError(`${field} is invalid.`, 400, 'INVALID_STUDIO_REQUEST');
  }
  const identifiers = value.map((entry) => optionalString(entry, field, 180));
  if (identifiers.some((entry) => !entry) || new Set(identifiers).size !== identifiers.length) {
    throw new MobileStudioError(`${field} is invalid.`, 400, 'INVALID_STUDIO_REQUEST');
  }
  return identifiers as string[];
}

function normalizeReferencePath(value: unknown): string {
  const referencePath = optionalString(value, 'Reference path', 1_000);
  if (
    !referencePath
    || !referencePath.startsWith('studio/')
    || referencePath.startsWith('/')
    || referencePath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new MobileStudioError('Reference path is invalid.', 400, 'INVALID_REFERENCE');
  }
  return referencePath;
}

function parseReferences(value: unknown, mode: MobileStudioMode, provider: string): MobileStudioReference[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_COUNT) {
    throw new MobileStudioError('Too many Studio references were selected.', 400, 'REFERENCE_LIMIT');
  }
  const references = value.map((entry) => {
    if (!isRecord(entry) || !['image', 'video', 'audio'].includes(String(entry.kind))) {
      throw new MobileStudioError('A Studio reference is invalid.', 400, 'INVALID_REFERENCE');
    }
    return {
      kind: entry.kind as MobileStudioReferenceKind,
      path: normalizeReferencePath(entry.path),
    };
  });
  if (mode === 'image' && references.some((reference) => reference.kind !== 'image')) {
    throw new MobileStudioError('Image generation accepts image references only.', 400, 'INVALID_REFERENCE');
  }
  if (mode === 'sound' && references.some((reference) => reference.kind !== 'image')) {
    throw new MobileStudioError('Sound generation accepts visual references only.', 400, 'INVALID_REFERENCE');
  }
  if (mode === 'video') {
    const imageLimit = provider === 'bytedance' ? 9 : 3;
    if (references.filter((reference) => reference.kind === 'image').length > imageLimit) {
      throw new MobileStudioError(`This video provider accepts at most ${imageLimit} image references.`, 400, 'REFERENCE_LIMIT');
    }
    if (provider !== 'bytedance' && references.some((reference) => reference.kind !== 'image')) {
      throw new MobileStudioError('Veo Quick Create accepts image references only.', 400, 'INVALID_REFERENCE');
    }
    if (references.filter((reference) => reference.kind === 'video').length > 3
      || references.filter((reference) => reference.kind === 'audio').length > 3) {
      throw new MobileStudioError('Seedance accepts at most three video and three audio references.', 400, 'REFERENCE_LIMIT');
    }
  }
  return references;
}

export function parseMobileStudioGenerationRequest(value: unknown): StudioGenerateRequest {
  if (!isRecord(value)) {
    throw new MobileStudioError('Studio request is invalid.', 400, 'INVALID_STUDIO_REQUEST');
  }
  const mode = enumValue(value.mode, ['image', 'video', 'sound'] as const, 'image', 'Mode');
  const providers = MODE_PROVIDERS[mode];
  const provider = enumValue(value.provider, providers, providers[0], 'Provider');
  const models = getModelsForProvider(mode, provider).map((model) => model.id);
  const model = enumValue(value.model, models, getDefaultModelForProvider(mode, provider), 'Model');
  const aspectRatios = getAspectRatiosForProvider(mode, provider);
  const aspectRatio = mode === 'sound'
    ? '1:1'
    : enumValue(value.aspectRatio, aspectRatios, aspectRatios[0] || '1:1', 'Aspect ratio');
  const prompt = optionalString(value.prompt, 'Prompt', 4_000) || '';
  const references = parseReferences(value.references, mode, provider);
  const productIds = identifierArray(value.productIds, 'Products', 5);
  const personaIds = identifierArray(value.personaIds, 'Personas', 3);
  const styleIds = identifierArray(value.styleIds, 'Styles', 3);
  const videoExtendSourcePath = value.videoExtendSourcePath === undefined || value.videoExtendSourcePath === null
    ? null
    : normalizeReferencePath(value.videoExtendSourcePath);
  const startFramePath = value.startFramePath === undefined || value.startFramePath === null
    ? null
    : normalizeReferencePath(value.startFramePath);
  const endFramePath = value.endFramePath === undefined || value.endFramePath === null
    ? null
    : normalizeReferencePath(value.endFramePath);
  if (mode === 'sound' && !prompt) {
    throw new MobileStudioError('Sound generation requires a prompt.', 400, 'PROMPT_REQUIRED');
  }
  if (
    !prompt
    && references.length === 0
    && productIds.length === 0
    && personaIds.length === 0
    && styleIds.length === 0
    && !value.sourceOutputId
    && !videoExtendSourcePath
  ) {
    throw new MobileStudioError('Add a prompt or at least one reference.', 400, 'PROMPT_OR_REFERENCE_REQUIRED');
  }
  const presetId = optionalString(value.presetId, 'Preset', 180);
  const sourceOutputId = optionalString(value.sourceOutputId, 'Source output', 180);
  const maxCount = Math.min(4, getMaxImageCountForProvider(mode, provider));
  const count = integerValue(value.count, 1, 1, maxCount, 'Output count');
  const quality = enumValue(value.quality, QUALITY_OPTIONS, 'auto', 'Quality');
  const background = enumValue(value.background, BACKGROUND_OPTIONS, 'auto', 'Background');
  const imageFormats = ['png', 'jpeg', 'webp'] as const;
  const soundFormats = ['mp3', 'wav'] as const;
  const outputFormat = mode === 'sound'
    ? enumValue(value.outputFormat, soundFormats, 'mp3', 'Output format')
    : enumValue(value.outputFormat, imageFormats, 'png', 'Output format');
  const imageSizes = mode === 'image' && provider === 'gemini' ? getImageSizesForModel(model) : [];
  const imageSize = imageSizes.length
    ? enumValue(value.imageSize, imageSizes, imageSizes[0], 'Image size')
    : undefined;
  const videoResolutions = mode === 'video' ? getVideoResolutionsForModel(model) : [];
  const videoResolution = mode === 'video'
    ? enumValue(value.videoResolution, videoResolutions, videoResolutions[0] || '720p', 'Video resolution')
    : undefined;
  const videoDurations = mode === 'video' ? getVideoDurationsForModel(model) : [];
  const videoDuration = mode === 'video'
    ? integerValue(value.videoDuration, videoDurations[0] || 6, Math.min(...videoDurations), Math.max(...videoDurations), 'Video duration')
    : undefined;
  if (mode === 'video' && !videoDurations.includes(videoDuration as never)) {
    throw new MobileStudioError('Video duration is not supported by this model.', 400, 'UNSUPPORTED_STUDIO_OPTION');
  }
  const isLooping = mode === 'video' ? booleanValue(value.isLooping, false) : undefined;
  const personGeneration = mode === 'video'
    ? enumValue(value.personGeneration, ['allow_all', 'allow_adult', 'dont_allow'] as const, 'allow_all', 'Person generation')
    : undefined;
  const videoWebSearch = mode === 'video' ? booleanValue(value.videoWebSearch, false) : undefined;
  const videoNsfwChecker = mode === 'video' ? booleanValue(value.videoNsfwChecker, true) : undefined;
  if (mode !== 'video' && (videoExtendSourcePath || startFramePath || endFramePath)) {
    throw new MobileStudioError('Video frame options require video mode.', 400, 'UNSUPPORTED_STUDIO_OPTION');
  }
  if (provider !== 'veo' && (videoExtendSourcePath || startFramePath || endFramePath || isLooping || value.personGeneration !== undefined)) {
    throw new MobileStudioError('Frame, loop, extension, and person options require Google Veo.', 400, 'UNSUPPORTED_STUDIO_OPTION');
  }
  if (provider !== 'bytedance' && (videoWebSearch || value.videoNsfwChecker !== undefined)) {
    throw new MobileStudioError('Web search and NSFW checking require Seedance.', 400, 'UNSUPPORTED_STUDIO_OPTION');
  }

  return {
    prompt,
    mode,
    product_ids: productIds,
    persona_ids: personaIds,
    style_ids: styleIds,
    provider,
    model,
    aspect_ratio: aspectRatio,
    count,
    preset_id: presetId || undefined,
    source_output_id: sourceOutputId || undefined,
    quality,
    output_format: outputFormat,
    background,
    image_size: imageSize,
    video_resolution: videoResolution,
    video_duration: videoDuration,
    video_generate_audio: mode === 'video' ? booleanValue(value.videoGenerateAudio, true) : undefined,
    video_extend_source_path: videoExtendSourcePath,
    start_frame_path: startFramePath || undefined,
    end_frame_path: endFramePath || undefined,
    is_looping: isLooping,
    person_generation: personGeneration,
    video_web_search: videoWebSearch,
    video_nsfw_checker: videoNsfwChecker,
    extra_reference_urls: references.filter((reference) => reference.kind === 'image').map((reference) => reference.path),
    video_reference_urls: references.filter((reference) => reference.kind === 'video').map((reference) => reference.path),
    audio_reference_urls: references.filter((reference) => reference.kind === 'audio').map((reference) => reference.path),
  };
}

function modelLabel(modelId: string): string {
  const labels: Record<string, string> = {
    'gemini-3.1-flash-image': 'Gemini Flash Image',
    'gemini-3-pro-image': 'Gemini Pro Image',
    'gpt-image-2': 'GPT Image 2',
    'veo-3.1-generate-preview': 'Veo 3.1 Quality',
    'veo-3.1-fast-generate-preview': 'Veo 3.1 Fast',
    'veo-3.1-lite-generate-preview': 'Veo 3.1 Lite',
    'bytedance/seedance-2': 'Seedance 2',
    'lyria-3-clip-preview': 'Lyria 3 Clip',
    'lyria-3-pro-preview': 'Lyria 3 Pro',
  };
  return labels[modelId] || modelId;
}

function providerAvailable(
  mode: MobileStudioMode,
  provider: string,
  config: Awaited<ReturnType<typeof getStudioProviderConfig>>,
): boolean {
  if (config.managedMediaAvailable) return true;
  if (mode === 'video' && provider === 'bytedance') return config.localApiKeys.kie;
  if (mode === 'image' && provider === 'openai') return config.localApiKeys.openai;
  return config.localApiKeys.gemini;
}

export async function getMobileStudioCatalog(input: {
  scope: StudioScope;
  userId: string;
  canWrite: boolean;
  canDeleteAssets: boolean;
}) {
  const [config, presets, products, personas, styles] = await Promise.all([
    getStudioProviderConfig({ userId: input.userId }),
    listPresets(input.scope),
    listProducts(input.scope),
    listPersonas(input.scope),
    listStyles(input.scope),
  ]);
  const modes = (Object.keys(MODE_PROVIDERS) as MobileStudioMode[]).map((mode) => ({
    id: mode,
    providers: MODE_PROVIDERS[mode].map((provider) => ({
      id: provider,
      label: provider === 'gemini' ? 'Google Gemini' : provider === 'openai' ? 'OpenAI' : provider === 'veo' ? 'Google Veo' : 'Bytedance',
      available: providerAvailable(mode, provider, config),
      models: getModelsForProvider(mode, provider).map((model) => ({
        id: model.id,
        label: modelLabel(model.id),
        aspectRatios: [...getAspectRatiosForProvider(mode, provider)],
        imageSizes: mode === 'image' && provider === 'gemini' ? [...getImageSizesForModel(model.id)] : [],
        videoResolutions: mode === 'video' ? [...getVideoResolutionsForModel(model.id)] : [],
        videoDurations: mode === 'video' ? [...getVideoDurationsForModel(model.id)] : [],
      })),
    })),
  }));
  return {
    actions: {
      canCreate: input.canWrite,
      canImportReferences: input.canWrite,
      canSaveToWorkspace: input.canWrite,
      canManageLibrary: input.canWrite,
      canDeleteAssets: input.canDeleteAssets,
    },
    options: {
      qualities: [...QUALITY_OPTIONS],
      backgrounds: [...BACKGROUND_OPTIONS],
      imageOutputFormats: ['png', 'jpeg', 'webp'],
      soundOutputFormats: ['mp3', 'wav'],
      personGeneration: ['allow_all', 'allow_adult', 'dont_allow'],
    },
    modes,
    startingPoints: STUDIO_STARTING_POINTS,
    presets: presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description || '',
      category: preset.category || 'custom',
      tags: preset.tags,
      isDefault: preset.isDefault,
      hasPreview: Boolean(preset.previewImagePath),
    })),
    library: {
      products: products.slice(0, 250).map(serializeLibraryEntity),
      personas: personas.slice(0, 250).map(serializeLibraryEntity),
      styles: styles.slice(0, 250).map(serializeLibraryEntity),
    },
  };
}

function serializeLibraryEntity(entity: {
  id: string;
  name: string;
  description?: string | null;
  imageCount: number;
  thumbnailPath?: string | null;
  updatedAt: Date | number | string;
}) {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description || '',
    imageCount: entity.imageCount,
    hasPreview: Boolean(entity.thumbnailPath),
    updatedAt: isoDate(entity.updatedAt),
  };
}

function isoDate(value: Date | number | string | null | undefined): string {
  const date = value instanceof Date ? value : new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function scrubError(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim()
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/giu, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '[redacted]')
    .slice(0, 500);
}

function generationError(metadata: unknown): string | null {
  if (typeof metadata !== 'string' || !metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return scrubError(parsed.error);
  } catch {
    return null;
  }
}

function generationMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata !== 'string' || !metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function metadataString(metadata: Record<string, unknown>, key: string, maximumLength = 1_000): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length <= maximumLength ? value : null;
}

function metadataBoolean(metadata: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof metadata[key] === 'boolean' ? metadata[key] : fallback;
}

function metadataInteger(metadata: Record<string, unknown>, key: string, fallback: number): number {
  return Number.isSafeInteger(metadata[key]) && Number(metadata[key]) > 0 ? Number(metadata[key]) : fallback;
}

function metadataPaths(metadata: Record<string, unknown>, key: string): string[] {
  const values = metadata[key];
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => (
    typeof value === 'string'
    && value.length <= 1_000
    && value.startsWith('studio/')
    && !value.split('/').some((part) => !part || part === '.' || part === '..')
  )).slice(0, MAX_REFERENCE_COUNT);
}

function outputType(value: unknown, mimeType: unknown): MobileStudioMode {
  if (value === 'video' || (typeof mimeType === 'string' && mimeType.startsWith('video/'))) return 'video';
  if (value === 'sound' || (typeof mimeType === 'string' && mimeType.startsWith('audio/'))) return 'sound';
  return 'image';
}

type StudioGenerationValue = NonNullable<Awaited<ReturnType<typeof getStudioGeneration>>>;

export function serializeMobileStudioGeneration(generation: StudioGenerationValue) {
  const metadata = generationMetadata(generation.metadata);
  return {
    id: generation.id,
    mode: generation.mode,
    prompt: generation.rawPrompt || generation.prompt || '',
    preset: generation.studioPresetId ? {
      id: generation.studioPresetId,
      name: generation.studioPresetName || 'Preset',
    } : null,
    aspectRatio: generation.aspectRatio,
    provider: generation.provider,
    model: generation.model,
    status: generation.status,
    error: generationError(generation.metadata),
    settings: {
      count: metadataInteger(metadata, 'count', Math.max(1, generation.outputs.length)),
      quality: metadataString(metadata, 'quality', 20) || 'auto',
      outputFormat: metadataString(metadata, 'outputFormat', 20) || (generation.mode === 'sound' ? 'mp3' : 'png'),
      background: metadataString(metadata, 'background', 20) || 'auto',
      imageSize: metadataString(metadata, 'imageSize', 40),
      videoResolution: metadataString(metadata, 'videoResolution', 40),
      videoDuration: Number.isSafeInteger(metadata.videoDuration) ? Number(metadata.videoDuration) : null,
      videoGenerateAudio: metadataBoolean(metadata, 'videoGenerateAudio', true),
      isLooping: metadataBoolean(metadata, 'isLooping', false),
      personGeneration: metadataString(metadata, 'personGeneration', 40) || 'allow_all',
      videoWebSearch: metadataBoolean(metadata, 'videoWebSearch', false),
      videoNsfwChecker: metadataBoolean(metadata, 'videoNsfwChecker', true),
    },
    references: {
      productIds: generation.product_ids,
      personaIds: generation.persona_ids,
      styleIds: generation.style_ids,
      files: [
        ...metadataPaths(metadata, 'extraReferenceUrls').map((referencePath) => ({ kind: 'image' as const, path: referencePath })),
        ...metadataPaths(metadata, 'videoReferenceUrls').map((referencePath) => ({ kind: 'video' as const, path: referencePath })),
        ...metadataPaths(metadata, 'audioReferenceUrls').map((referencePath) => ({ kind: 'audio' as const, path: referencePath })),
      ],
      sourceOutputId: metadataString(metadata, 'sourceOutputId', 180),
      videoExtendSourcePath: metadataString(metadata, 'videoExtendSourcePath'),
      startFramePath: metadataString(metadata, 'startFramePath'),
      endFramePath: metadataString(metadata, 'endFramePath'),
    },
    outputs: generation.outputs.map((output) => ({
      id: output.id,
      type: outputType(output.type, output.mimeType),
      fileName: path.basename(output.fileName || output.filePath || `studio-output-${output.id}`),
      mimeType: output.mimeType || 'application/octet-stream',
      fileSize: output.fileSize || 0,
      width: output.width || null,
      height: output.height || null,
      isFavorite: Boolean(output.isFavorite),
      createdAt: isoDate(output.createdAt),
    })),
    createdAt: isoDate(generation.createdAt),
    updatedAt: isoDate(generation.updatedAt),
  };
}

function cursorSignature(workspaceId: string): string {
  return createHash('sha256').update(`mobile-studio:${workspaceId}`).digest('hex').slice(0, 16);
}

function cursorFor(offset: number, workspaceId: string): string {
  return Buffer.from(JSON.stringify({ offset, signature: cursorSignature(workspaceId) })).toString('base64url');
}

function offsetFromCursor(value: unknown, workspaceId: string): number {
  if (!value) return 0;
  if (typeof value !== 'string' || value.length > 240) {
    throw new MobileStudioError('Studio cursor is invalid.', 400, 'INVALID_CURSOR');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0 || parsed.signature !== cursorSignature(workspaceId)) {
      throw new Error('invalid');
    }
    return Number(parsed.offset);
  } catch {
    throw new MobileStudioError('Studio cursor is invalid.', 400, 'INVALID_CURSOR');
  }
}

export async function listMobileStudioGenerations(input: {
  scope: StudioScope;
  cursor?: unknown;
  limit?: unknown;
}) {
  const limit = integerValue(input.limit === null ? undefined : Number(input.limit), 24, 1, MAX_LIST_LIMIT, 'Limit');
  const offset = offsetFromCursor(input.cursor, input.scope.workspaceId);
  const result = await listStudioGenerations(input.scope, { limit, offset });
  return {
    generations: result.generations.map(serializeMobileStudioGeneration),
    nextCursor: result.hasMore ? cursorFor(offset + result.generations.length, input.scope.workspaceId) : null,
  };
}

export async function getMobileStudioGeneration(input: {
  scope: StudioScope;
  generationId: string;
}) {
  const generationId = optionalString(input.generationId, 'Generation', 180);
  if (!generationId) throw new MobileStudioError('Generation is required.', 400, 'INVALID_GENERATION');
  const generation = await getStudioGeneration(generationId, input.scope);
  if (!generation) throw new MobileStudioError('Generation was not found.', 404, 'GENERATION_NOT_FOUND');
  return serializeMobileStudioGeneration(generation);
}

function mediaKind(mimeType: string): MobileStudioReferenceKind | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

function maximumReferenceBytes(kind: MobileStudioReferenceKind): number {
  if (kind === 'video') return MAX_VIDEO_REFERENCE_BYTES;
  if (kind === 'audio') return MAX_AUDIO_REFERENCE_BYTES;
  return MAX_IMAGE_REFERENCE_BYTES;
}

function safeReferenceName(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase().slice(0, 12);
  const base = path.posix.basename(filePath, extension).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 100) || 'reference';
  return `${base}${extension}`;
}

export async function importMobileStudioWorkspaceReference(input: {
  scope: StudioScope;
  fileOptions: WorkspaceFileOperationOptions;
  sourcePath: unknown;
}) {
  const sourcePath = normalizeMobileFilePath(input.sourcePath, false);
  const mimeType = getPublicShareMimeType(sourcePath);
  const kind = mediaKind(mimeType);
  if (!kind) throw new MobileStudioError('Only image, video, and audio files can be Studio references.', 400, 'UNSUPPORTED_REFERENCE');
  const stats = await getFileStats(sourcePath, input.fileOptions).catch(() => null);
  if (!stats?.isFile) throw new MobileStudioError('Workspace file was not found.', 404, 'REFERENCE_NOT_FOUND');
  if (stats.size > maximumReferenceBytes(kind)) {
    throw new MobileStudioError('Workspace file exceeds the Studio reference limit.', 413, 'REFERENCE_TOO_LARGE');
  }
  const buffer = await readFile(sourcePath, input.fileOptions);
  const name = safeReferenceName(sourcePath);
  const { relativePath } = generateStudioReferencePath(input.scope.storage, name);
  await writeAssetFile(relativePath, buffer);
  return { kind, path: relativePath, name, mimeType, size: buffer.length };
}

export async function resolveMobileStudioOutput(input: {
  scope: StudioScope;
  outputId: string;
}) {
  const outputId = optionalString(input.outputId, 'Output', 180);
  if (!outputId) throw new MobileStudioError('Output is required.', 400, 'INVALID_OUTPUT');
  const output = await getStudioOutputForUser(outputId, input.scope);
  if (!output) throw new MobileStudioError('Output was not found.', 404, 'OUTPUT_NOT_FOUND');
  return output;
}
