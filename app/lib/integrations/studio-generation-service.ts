import 'server-only';

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { db } from '@/app/lib/db';
import {
  user,
  studioProducts,
  studioProductImages,
  studioPersonas,
  studioPersonaImages,
  studioStyles,
  studioStyleImages,
  studioPresets,
  studioGenerations,
  studioGenerationOutputs,
  studioGenerationProducts,
  studioGenerationPersonas,
  studioGenerationStyles,
} from '@/app/lib/db/schema';
import { eq, and, desc, count, asc, inArray, or } from 'drizzle-orm';
import { getImageGenerationProvider } from '@/app/lib/integrations/image-generation-providers';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import {
  readAssetFile,
  ensureStudioOutputsWorkspace,
  generateOutputFilename,
  generateOutputPath,
  getStudioWorkspaceVirtualRoot,
  writeOutputFile,
  readOutputFile,
  STUDIO_SYSTEM_PRESETS_DIR,
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { generateVideo, type GenerateVideoRequestBody } from '@/app/lib/integrations/veo-generation-service';
import {
  generateSeedanceVideo,
  SEEDANCE_MODEL_ID,
  SEEDANCE_PROVIDER_ID,
  type SeedanceAspectRatio,
  type SeedanceReferenceMedia,
  type SeedanceResolution,
} from '@/app/lib/integrations/seedance-generation-service';
import { classifyMediaReference, loadMediaReference, loadMediaReferences } from '@/app/lib/integrations/media-reference-resolver';
import { generateSound, LYRIA_CLIP_MODEL_ID, LYRIA_PRO_MODEL_ID, type SoundOutputFormat } from '@/app/lib/integrations/sound-generation-service';
import {
  GEMINI_FLASH_IMAGE_MODEL_ID,
  SEEDANCE_MAX_REFERENCE_IMAGES,
  VEO_MAX_REFERENCE_IMAGES,
  normalizeGeminiImageModelId,
  normalizeOpenAIImageOutputFormat,
} from '@/app/lib/integrations/image-generation-constants';
import { withStudioGenerationConcurrency } from '@/app/lib/integrations/studio-generation-concurrency';
import type { EnvStorageScope } from '@/app/lib/integrations/env-config';
import {
  createPersistedStudioScope,
  studioVisibilityCondition,
  type StudioScope,
} from '@/app/lib/integrations/studio-scope';

type ProviderReferenceImage = { imageBytes: string; mimeType: string };
type ProviderReferenceMedia = { imageBytes: string; mimeType: string; fileName?: string };

interface LoadedReferenceImage {
  imageBytes: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileName: string;
  source: 'product' | 'persona' | 'style' | 'source_output' | 'extra_url';
  sourceId: string;
  sourceName: string;
  description?: string;
}

export interface StudioGenerateRequest {
  prompt: string;
  client_request_id?: string;
  mode?: 'image' | 'video' | 'sound';
  product_ids?: string[];
  persona_ids?: string[];
  style_ids?: string[];
  preset_id?: string;
  aspect_ratio?: string;
  count?: number;
  provider?: string;
  model?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  output_format?: 'png' | 'jpeg' | 'webp' | 'mp3' | 'wav';
  background?: 'transparent' | 'opaque' | 'auto';
  source_output_id?: string;
  pi_session_id?: string;
  extra_reference_urls?: string[];
  video_reference_urls?: string[];
  audio_reference_urls?: string[];
  video_extend_source_path?: string | null;
  video_resolution?: '480p' | '720p' | '1080p' | '4k';
  video_duration?: number;
  start_frame_path?: string;
  end_frame_path?: string;
  is_looping?: boolean;
  person_generation?: 'allow_all' | 'allow_adult' | 'dont_allow';
  video_generate_audio?: boolean;
  video_web_search?: boolean;
  video_nsfw_checker?: boolean;
  image_size?: string;
}

export interface StudioGenerationOutput {
  id: string;
  variationIndex: number;
  filePath: string;
  fileName?: string;
  mediaUrl: string;
  mimeType: string;
  fileSize: number;
}

export interface StudioGenerateResult {
  generationId: string;
  status: string;
  mode: string;
  prompt: string;
  outputs: StudioGenerationOutput[];
}

const MAX_PRODUCTS = 5;
const MAX_PERSONAS = 3;
const MAX_STYLES = 3;
const MAX_IMAGE_COUNT = 4;

const PRESET_BLOCK_ORDER = ['lighting', 'camera', 'background', 'props', 'subject'];
const MAX_PROMPT_LENGTH = 4000;

function generationVisibilityCondition(scope: StudioScope, creatorUserId?: string | null) {
  return studioVisibilityCondition(scope, {
    workspaceId: studioGenerations.workspaceId,
    createdByUserId: studioGenerations.createdByUserId,
  }, creatorUserId);
}

function productVisibilityCondition(scope: StudioScope) {
  return studioVisibilityCondition(scope, {
    workspaceId: studioProducts.workspaceId,
    createdByUserId: studioProducts.createdByUserId,
  });
}

function personaVisibilityCondition(scope: StudioScope) {
  return studioVisibilityCondition(scope, {
    workspaceId: studioPersonas.workspaceId,
    createdByUserId: studioPersonas.createdByUserId,
  });
}

function styleVisibilityCondition(scope: StudioScope) {
  return studioVisibilityCondition(scope, {
    workspaceId: studioStyles.workspaceId,
    createdByUserId: studioStyles.createdByUserId,
  });
}

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH);
}

function extensionFromMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType] || (mimeType.startsWith('image/') ? 'png' : 'bin');
}

function getVideoProviderImageReferenceLimit(providerId: string): number {
  return providerId === SEEDANCE_PROVIDER_ID ? SEEDANCE_MAX_REFERENCE_IMAGES : VEO_MAX_REFERENCE_IMAGES;
}

function limitVideoProviderReferenceImages(providerId: string, referenceImages: ProviderReferenceImage[]): ProviderReferenceImage[] {
  return referenceImages.slice(0, getVideoProviderImageReferenceLimit(providerId));
}

async function loadProductImages(scope: StudioScope, productIds: string[]): Promise<LoadedReferenceImage[]> {
  if (productIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const productId of productIds) {
    const [product] = await db.select({ id: studioProducts.id, name: studioProducts.name, description: studioProducts.description })
      .from(studioProducts)
      .where(and(eq(studioProducts.id, productId), productVisibilityCondition(scope)));

    if (!product) {
      throw new StudioServiceError(
        `Product ${productId} not found`,
        `Produkt '${productId}' wurde gelöscht. Bitte entferne diese Referenz und wähle ein anderes Produkt. Verwende studio_list_products um verfügbare Produkte zu sehen.`,
        'NOT_FOUND',
      );
    }

    const productImages = await db.select()
      .from(studioProductImages)
      .where(eq(studioProductImages.productId, productId))
      .orderBy(asc(studioProductImages.sortOrder));

    for (const img of productImages) {
      let buffer: Buffer;
      try {
        buffer = await readAssetFile(img.filePath);
      } catch {
        throw new StudioServiceError(
          `Reference image file not found for product '${product.name}' (${img.fileName})`,
          `Referenzbild-Datei nicht gefunden für Produkt '${product.name}' (${img.fileName}). Die Datei wurde möglicherweise gelöscht. Bitte lade das Bild erneut hoch.`,
          'FILE_NOT_FOUND',
        );
      }

      images.push({
        imageBytes: buffer.toString('base64'),
        mimeType: img.mimeType,
        width: img.width,
        height: img.height,
        fileName: img.fileName,
        source: 'product',
        sourceId: productId,
        sourceName: product.name,
        description: product.description || undefined,
      });
    }
  }

  return images;
}

async function loadPersonaImages(scope: StudioScope, personaIds: string[]): Promise<LoadedReferenceImage[]> {
  if (personaIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const personaId of personaIds) {
    const [persona] = await db.select({ id: studioPersonas.id, name: studioPersonas.name, description: studioPersonas.description })
      .from(studioPersonas)
      .where(and(eq(studioPersonas.id, personaId), personaVisibilityCondition(scope)));

    if (!persona) {
      throw new StudioServiceError(
        `Persona ${personaId} not found`,
        `Persona '${personaId}' wurde gelöscht. Bitte entferne diese Referenz und wähle eine andere Persona. Verwende studio_list_personas um verfügbare Personen zu sehen.`,
        'NOT_FOUND',
      );
    }

    const personaImages = await db.select()
      .from(studioPersonaImages)
      .where(eq(studioPersonaImages.personaId, personaId))
      .orderBy(asc(studioPersonaImages.sortOrder));

    for (const img of personaImages) {
      let buffer: Buffer;
      try {
        buffer = await readAssetFile(img.filePath);
      } catch {
        throw new StudioServiceError(
          `Reference image file not found for persona '${persona.name}' (${img.fileName})`,
          `Referenzbild-Datei nicht gefunden für Persona '${persona.name}' (${img.fileName}). Die Datei wurde möglicherweise gelöscht. Bitte lade das Bild erneut hoch.`,
          'FILE_NOT_FOUND',
        );
      }

      images.push({
        imageBytes: buffer.toString('base64'),
        mimeType: img.mimeType,
        width: img.width,
        height: img.height,
        fileName: img.fileName,
        source: 'persona',
        sourceId: personaId,
        sourceName: persona.name,
        description: persona.description || undefined,
      });
    }
  }

  return images;
}

async function loadStyleImages(scope: StudioScope, styleIds: string[]): Promise<LoadedReferenceImage[]> {
  if (styleIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const styleId of styleIds) {
    const [style] = await db.select({ id: studioStyles.id, name: studioStyles.name, description: studioStyles.description })
      .from(studioStyles)
      .where(and(eq(studioStyles.id, styleId), styleVisibilityCondition(scope)));

    if (!style) {
      throw new StudioServiceError(
        `Style ${styleId} not found`,
        `Style '${styleId}' wurde gelöscht. Bitte entferne diese Referenz und wähle einen anderen Style.`,
        'NOT_FOUND',
      );
    }

    const styleImages = await db.select()
      .from(studioStyleImages)
      .where(eq(studioStyleImages.styleId, styleId))
      .orderBy(asc(studioStyleImages.sortOrder));

    for (const img of styleImages) {
      let buffer: Buffer;
      try {
        buffer = await readAssetFile(img.filePath);
      } catch {
        throw new StudioServiceError(
          `Reference image file not found for style '${style.name}' (${img.fileName})`,
          `Referenzbild-Datei nicht gefunden für Style '${style.name}' (${img.fileName}). Die Datei wurde möglicherweise gelöscht. Bitte lade das Bild erneut hoch.`,
          'FILE_NOT_FOUND',
        );
      }

      images.push({
        imageBytes: buffer.toString('base64'),
        mimeType: img.mimeType,
        width: img.width,
        height: img.height,
        fileName: img.fileName,
        source: 'style',
        sourceId: styleId,
        sourceName: style.name,
        description: style.description || undefined,
      });
    }
  }

  return images;
}

export async function getStudioOutputForUser(outputId: string, scope: StudioScope) {
  const [output] = await db.select({
    id: studioGenerationOutputs.id,
    generationId: studioGenerationOutputs.generationId,
    type: studioGenerationOutputs.type,
    filePath: studioGenerationOutputs.filePath,
    fileName: studioGenerationOutputs.fileName,
    mimeType: studioGenerationOutputs.mimeType,
    width: studioGenerationOutputs.width,
    height: studioGenerationOutputs.height,
    metadata: studioGenerationOutputs.metadata,
    generationProvider: studioGenerations.provider,
    generationModel: studioGenerations.model,
  })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(and(eq(studioGenerationOutputs.id, outputId), generationVisibilityCondition(scope)))
    .limit(1);

  return output ?? null;
}

export async function canReadStudioOutputPath(inputPath: string, scope: StudioScope): Promise<boolean> {
  const normalizedPath = inputPath.startsWith('studio/outputs/')
    ? inputPath.slice('studio/outputs/'.length)
    : inputPath;

  const [output] = await db.select({ id: studioGenerationOutputs.id })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(and(
      or(
        eq(studioGenerationOutputs.filePath, normalizedPath),
        eq(studioGenerationOutputs.filePath, `studio/outputs/${normalizedPath}`),
      )!,
      generationVisibilityCondition(scope),
    ))
    .limit(1);

  return Boolean(output);
}

function isVeoGenerationOutput(output: {
  type: string;
  mimeType: string | null;
  metadata: string | null;
  generationProvider: string | null;
  generationModel: string | null;
}): boolean {
  if (output.type !== 'video' || !output.mimeType?.startsWith('video/')) {
    return false;
  }

  if (output.generationProvider === 'veo' && output.generationModel?.startsWith('veo-')) {
    return true;
  }

  if (!output.metadata) {
    return false;
  }

  try {
    const parsed = JSON.parse(output.metadata) as { provider?: unknown; model?: unknown };
    return parsed.provider === 'gemini' && typeof parsed.model === 'string' && parsed.model.startsWith('veo-');
  } catch {
    return false;
  }
}

async function getVeoVideoOutputByPathForUser(inputPath: string, scope: StudioScope) {
  const classified = classifyMediaReference(inputPath, { userId: scope.actorUserId });
  const candidates = new Set<string>();
  const rawPath = inputPath.trim().split(/[?#]/, 1)[0] || inputPath.trim();
  const decodedRawPath = (() => {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return rawPath;
    }
  })();

  if (classified?.kind === 'studio_output') {
    candidates.add(classified.relativePath);
    candidates.add(`studio/outputs/${classified.relativePath}`);
  }

  const withoutApiPrefix = decodedRawPath
    .replace(/^\/api\/studio\/media\//, '')
    .replace(/^\/+/, '');
  candidates.add(withoutApiPrefix);
  if (withoutApiPrefix.startsWith('studio/outputs/')) {
    candidates.add(withoutApiPrefix.slice('studio/outputs/'.length));
  }

  for (const candidate of candidates) {
    const [output] = await db.select({
      id: studioGenerationOutputs.id,
      generationId: studioGenerationOutputs.generationId,
      type: studioGenerationOutputs.type,
      filePath: studioGenerationOutputs.filePath,
      fileName: studioGenerationOutputs.fileName,
      mimeType: studioGenerationOutputs.mimeType,
      metadata: studioGenerationOutputs.metadata,
      generationProvider: studioGenerations.provider,
      generationModel: studioGenerations.model,
    })
      .from(studioGenerationOutputs)
      .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
      .where(and(eq(studioGenerationOutputs.filePath, candidate), generationVisibilityCondition(scope)))
      .limit(1);

    if (output) {
      return output;
    }
  }

  return null;
}

async function loadSourceOutputImage(scope: StudioScope, sourceOutputId: string): Promise<LoadedReferenceImage> {
  const output = await getStudioOutputForUser(sourceOutputId, scope);

  if (!output) {
    throw new StudioServiceError(
      `Source output ${sourceOutputId} not found`,
      `Das Quell-Bild (${sourceOutputId}) wurde nicht gefunden. Es wurde möglicherweise gelöscht.`,
      'NOT_FOUND',
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readOutputFile(output.filePath);
  } catch {
    throw new StudioServiceError(
      `Source output file not found: ${output.filePath}`,
      `Die Datei des Quell-Bildes wurde nicht gefunden. Sie wurde möglicherweise gelöscht.`,
      'FILE_NOT_FOUND',
    );
  }

  return {
    imageBytes: buffer.toString('base64'),
    mimeType: output.mimeType || 'image/png',
    width: output.width,
    height: output.height,
    fileName: output.filePath.split('/').pop() || 'source.png',
    source: 'source_output',
    sourceId: sourceOutputId,
    sourceName: 'Source Image',
  };
}

async function composePresetPromptFragment(presetId: string, scope: StudioScope): Promise<string> {
  const [preset] = await db.select()
    .from(studioPresets)
    .where(and(
      eq(studioPresets.id, presetId),
      or(
        eq(studioPresets.workspaceId, scope.workspaceId),
        eq(studioPresets.isDefault, true),
      ),
    ));

  if (!preset) {
    throw new StudioServiceError(
      `Preset ${presetId} not found`,
      `Studio-Preset '${presetId}' wurde nicht gefunden. Verwende studio_list_presets um verfügbare Presets zu sehen.`,
      'NOT_FOUND',
    );
  }

  let blocks: Array<{ type: string; promptFragment?: string }>;
  try {
    blocks = JSON.parse(preset.blocks);
  } catch {
    return '';
  }

  if (!Array.isArray(blocks)) return '';

  const sorted = [...blocks].sort((a, b) => {
    const idxA = PRESET_BLOCK_ORDER.indexOf(a.type);
    const idxB = PRESET_BLOCK_ORDER.indexOf(b.type);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });

  return sorted
    .map((b) => b.promptFragment)
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    .join(' ')
    .trim();
}

async function loadSourceOutputReferences(scope: StudioScope, sourceGenerationId: string): Promise<{
  product_ids: string[];
  persona_ids: string[];
  style_ids: string[];
}> {
  const [generation] = await db.select({ id: studioGenerations.id })
    .from(studioGenerations)
    .where(and(eq(studioGenerations.id, sourceGenerationId), generationVisibilityCondition(scope)))
    .limit(1);

  if (!generation) {
    throw new StudioServiceError(
      `Source generation ${sourceGenerationId} not found`,
      'Die Quell-Generierung wurde nicht gefunden.',
      'NOT_FOUND',
    );
  }

  const productRows = await db.select({ productId: studioGenerationProducts.productId })
    .from(studioGenerationProducts)
    .where(eq(studioGenerationProducts.generationId, sourceGenerationId));

  const personaRows = await db.select({ personaId: studioGenerationPersonas.personaId })
    .from(studioGenerationPersonas)
    .where(eq(studioGenerationPersonas.generationId, sourceGenerationId));

  const styleRows = await db.select({ styleId: studioGenerationStyles.styleId })
    .from(studioGenerationStyles)
    .where(eq(studioGenerationStyles.generationId, sourceGenerationId));

  return {
    product_ids: productRows.map((r) => r.productId),
    persona_ids: personaRows.map((r) => r.personaId),
    style_ids: styleRows.map((r) => r.styleId),
  };
}

function studioPathFromReference(value: string): string | null {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed, 'http://canvas.local');
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath.startsWith('/api/studio/media/')) {
      return decodedPath.slice('/api/studio/media/'.length).replace(/^\/+/, '');
    }
    if (decodedPath.startsWith('/studio/')) return decodedPath.slice(1);
  } catch {
    // Fall through to plain-path handling.
  }
  const normalized = trimmed.split(/[?#]/, 1)[0]?.replace(/^\/+/, '') ?? '';
  return normalized.startsWith('studio/') ? normalized : null;
}

async function assertStudioReferenceReadable(value: string, scope: StudioScope): Promise<void> {
  const studioPath = studioPathFromReference(value);
  if (!studioPath) return;
  const workspaceRoot = getStudioWorkspaceVirtualRoot(scope.storage);
  if (studioPath.startsWith(`${workspaceRoot}/`) || studioPath.startsWith(`${STUDIO_SYSTEM_PRESETS_DIR}/`)) return;
  if (studioPath.startsWith('studio/outputs/') && await canReadStudioOutputPath(studioPath, scope)) return;
  throw new StudioServiceError(
    `Studio reference is outside workspace ${scope.workspaceId}`,
    'Die ausgewählte Studio-Referenz gehört zu einem anderen Workspace.',
    'FORBIDDEN',
  );
}

async function loadExtraReferenceImages(scope: StudioScope, urls: string[]): Promise<LoadedReferenceImage[]> {
  if (urls.length === 0) return [];

  console.log(`[Studio Generation] Loading ${urls.length} extra reference images`);
  await Promise.all(urls.map((url) => assertStudioReferenceReadable(url, scope)));
  const files = await loadMediaReferences(urls, { userId: scope.actorUserId, allowedTypes: ['image'] });

  return files.map((file) => ({
    imageBytes: file.imageBytes,
    mimeType: file.mimeType.startsWith('image/') ? file.mimeType : 'image/png',
    width: file.width,
    height: file.height,
    fileName: file.fileName,
    source: 'extra_url',
    sourceId: file.sourceId,
    sourceName: 'Extra Reference',
  }));
}

async function loadExtraReferenceMedia(scope: StudioScope, urls: string[], mediaType: 'video' | 'audio'): Promise<ProviderReferenceMedia[]> {
  if (urls.length === 0) return [];

  console.log(`[Studio Generation] Loading ${urls.length} extra ${mediaType} references`);
  await Promise.all(urls.map((url) => assertStudioReferenceReadable(url, scope)));
  const files = await loadMediaReferences(urls, { userId: scope.actorUserId, allowedTypes: [mediaType] });
  return files.map((file) => ({
    imageBytes: file.videoBytes || file.imageBytes,
    mimeType: file.mimeType,
    fileName: file.fileName,
  }));
}

function buildReferenceContextPrompt(referenceImages: LoadedReferenceImage[]): { contextText: string; providerImages: ProviderReferenceImage[] } {
  if (referenceImages.length === 0) {
    return { contextText: '', providerImages: [] };
  }

  const providerImages = referenceImages.map((img) => ({
    imageBytes: img.imageBytes,
    mimeType: img.mimeType,
  }));

  const groups = new Map<string, LoadedReferenceImage[]>();
  
  for (const img of referenceImages) {
    const key = `${img.source}:${img.sourceId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(img);
  }

  const sections: string[] = [];

  for (const images of groups.values()) {
    const first = images[0];
    const count = images.length;
    
    if (first.source === 'product') {
      let section = `### Product: ${first.sourceName}\n`;
      if (first.description) {
        section += `${first.description}\n`;
      }
      section += `The following ${count} image${count > 1 ? 's' : ''} show${count > 1 ? '' : 's'} this product from multiple angles. Use them to maintain the exact shape, texture, material, and design. Do NOT create a collage. Generate a single coherent image of this product.`;
      sections.push(section);
    } else if (first.source === 'persona') {
      let section = `### Persona: ${first.sourceName}\n`;
      if (first.description) {
        section += `${first.description}\n`;
      }
      section += `The following ${count} image${count > 1 ? 's' : ''} show${count > 1 ? '' : 's'} this person from various angles and expressions. Use them to maintain the exact facial features, body shape, clothing, and appearance. Do NOT create a collage. Generate a single coherent image of this person.`;
      sections.push(section);
    } else if (first.source === 'style') {
      let section = `### Style: ${first.sourceName}\n`;
      if (first.description) {
        section += `${first.description}\n`;
      }
      section += `The following ${count} image${count > 1 ? 's' : ''} provide visual style reference. Apply this aesthetic across the entire generation: colors, atmosphere, compositional approach, and finishing quality.`;
      sections.push(section);
    } else if (first.source === 'source_output') {
      let section = `### Source Image\n`;
      section += `The following ${count} image${count > 1 ? 's' : ''} ${count > 1 ? 'are' : 'is'} the previously generated output that should be used as the base for editing or variation.`;
      sections.push(section);
    } else if (first.source === 'extra_url') {
      let section = `### Additional References\n`;
      section += `The following ${count} image${count > 1 ? 's' : ''} provide additional visual context or style reference.`;
      sections.push(section);
    }
  }

  const contextText = `## References\n\nThe following images are reference material.\n\n${sections.join('\n\n')}\n\n---\n`;

  return { contextText, providerImages };
}

function buildSoundContextPrompt(referenceImages: LoadedReferenceImage[]): string {
  if (referenceImages.length === 0) return '';

  const groups = new Map<string, LoadedReferenceImage[]>();
  for (const img of referenceImages.slice(0, 10)) {
    const key = `${img.source}:${img.sourceId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(img);
  }

  const sections: string[] = [];
  for (const images of groups.values()) {
    const first = images[0];
    const count = images.length;
    const label = first.source === 'product'
      ? 'Product'
      : first.source === 'persona'
        ? 'Persona'
        : first.source === 'style'
          ? 'Visual style'
          : first.source === 'source_output'
            ? 'Source image'
            : 'Additional visual reference';
    const description = first.description ? ` ${first.description}` : '';
    sections.push(`${label}: ${first.sourceName}.${description} ${count} image${count === 1 ? '' : 's'} attached for mood, colors, setting, subject matter, texture, and energy.`);
  }

  return [
    'Use the attached images as inspiration for the music.',
    'Translate their mood, colors, visual rhythm, setting, subject matter, materials, and atmosphere into the arrangement.',
    'Do not describe the images in the output; generate the audio requested by the user.',
    '',
    ...sections,
  ].join('\n');
}

export interface ExistingStudioGenerationRequest {
  generationId: string;
  status: string;
  mode: string;
  prompt: string;
}

export async function findStudioGenerationByClientRequestId(
  scope: StudioScope,
  clientRequestId: string,
): Promise<ExistingStudioGenerationRequest | null> {
  const [generation] = await db.select({
    generationId: studioGenerations.id,
    status: studioGenerations.status,
    mode: studioGenerations.mode,
    prompt: studioGenerations.prompt,
  })
    .from(studioGenerations)
    .where(and(
      eq(studioGenerations.userId, scope.actorUserId),
      eq(studioGenerations.workspaceId, scope.workspaceId),
      eq(studioGenerations.idempotencyKey, clientRequestId),
      generationVisibilityCondition(scope),
    ))
    .limit(1);

  if (!generation) return null;
  return {
    ...generation,
    prompt: generation.prompt ?? '',
  };
}

export async function createStudioGeneration(
  scope: StudioScope,
  request: StudioGenerateRequest,
): Promise<{ generationId: string; mode: string; prompt: string }> {
  const mode = request.mode || 'image';
  const providerId = request.provider || (mode === 'video' ? 'veo' : 'gemini');
  const aspectRatio = request.aspect_ratio || '1:1';
  const rawPrompt = sanitizePrompt(request.prompt);
  const productIds = (request.product_ids || []).slice(0, MAX_PRODUCTS);
  const personaIds = (request.persona_ids || []).slice(0, MAX_PERSONAS);
  const styleIds = (request.style_ids || []).slice(0, MAX_STYLES);

  if (
    !rawPrompt &&
    productIds.length === 0 &&
    personaIds.length === 0 &&
    styleIds.length === 0 &&
    !request.source_output_id &&
    !(request.extra_reference_urls?.length) &&
    !(request.video_reference_urls?.length) &&
    !(request.audio_reference_urls?.length) &&
    !request.video_extend_source_path
  ) {
    throw new StudioServiceError(
      'Prompt or reference required',
      'Ein Prompt oder mindestens ein Referenz-Bild (Produkt/Persona) ist erforderlich.',
    );
  }
  if (mode === 'sound' && !rawPrompt) {
    throw new StudioServiceError(
      'Prompt required for sound generation',
      'Ein Prompt ist für Sound-Generierung erforderlich.',
    );
  }

  const generationId = randomUUID();
  const now = new Date();
  let sourceGenerationId: string | null = null;

  const defaultModel = providerId === 'openai' ? 'gpt-image-2' : GEMINI_FLASH_IMAGE_MODEL_ID;
  const videoDefaultModel = providerId === SEEDANCE_PROVIDER_ID ? SEEDANCE_MODEL_ID : 'veo-3.1-fast-generate-preview';
  const soundDefaultModel = LYRIA_CLIP_MODEL_ID;
  const requestedModel = mode === 'video'
    ? (request.model || videoDefaultModel)
    : mode === 'sound'
      ? (request.model || soundDefaultModel)
      : (request.model || defaultModel);
  const model = mode === 'image' && providerId === 'gemini'
    ? normalizeGeminiImageModelId(requestedModel)
    : requestedModel;

  if (request.source_output_id) {
    const sourceOutput = await getStudioOutputForUser(request.source_output_id, scope);
    sourceGenerationId = sourceOutput?.generationId ?? null;
  }
  if (request.video_extend_source_path) {
    if (mode !== 'video' || providerId !== 'veo') {
      throw new StudioServiceError(
        'Veo extension source can only be used with Veo video generation',
        'Video-Erweiterung ist nur mit Google Veo verfügbar.',
      );
    }
    const sourceOutput = await getVeoVideoOutputByPathForUser(request.video_extend_source_path, scope);
    if (!sourceOutput || !isVeoGenerationOutput(sourceOutput)) {
      throw new StudioServiceError(
        'Extension source must be a previous Veo video output',
        'Zum Erweitern kann nur ein vorher mit Veo erzeugtes Studio-Video verwendet werden.',
      );
    }
    sourceGenerationId = sourceOutput.generationId;
  }

  let studioPresetName = null;
  if (request.preset_id) {
    const [preset] = await db.select({ name: studioPresets.name })
      .from(studioPresets)
      .where(and(
        eq(studioPresets.id, request.preset_id),
        or(
          eq(studioPresets.workspaceId, scope.workspaceId),
          eq(studioPresets.isDefault, true),
        ),
      ));
    if (!preset) {
      throw new StudioServiceError(
        `Preset ${request.preset_id} not found in workspace ${scope.workspaceId}`,
        'Das ausgewählte Studio-Preset ist in diesem Workspace nicht verfügbar.',
        'NOT_FOUND',
      );
    }
    studioPresetName = preset?.name ?? null;
  }

  for (const productId of productIds) {
    const [product] = await db.select({ id: studioProducts.id })
      .from(studioProducts)
      .where(and(eq(studioProducts.id, productId), productVisibilityCondition(scope)))
      .limit(1);
    if (!product) throw new StudioServiceError('Product not found in workspace', 'Produkt nicht gefunden.', 'NOT_FOUND');
  }
  for (const personaId of personaIds) {
    const [persona] = await db.select({ id: studioPersonas.id })
      .from(studioPersonas)
      .where(and(eq(studioPersonas.id, personaId), personaVisibilityCondition(scope)))
      .limit(1);
    if (!persona) throw new StudioServiceError('Persona not found in workspace', 'Persona nicht gefunden.', 'NOT_FOUND');
  }
  for (const styleId of styleIds) {
    const [style] = await db.select({ id: studioStyles.id })
      .from(studioStyles)
      .where(and(eq(studioStyles.id, styleId), styleVisibilityCondition(scope)))
      .limit(1);
    if (!style) throw new StudioServiceError('Style not found in workspace', 'Style nicht gefunden.', 'NOT_FOUND');
  }

  const requestMetadata = JSON.stringify({
    productIds,
    personaIds,
    styleIds,
    presetId: request.preset_id ?? null,
    aspectRatio,
    count: request.count,
    provider: providerId,
    model,
    quality: request.quality,
    outputFormat: request.output_format,
    background: request.background,
    imageSize: request.image_size,
    videoResolution: request.video_resolution,
    videoDuration: request.video_duration,
    videoGenerateAudio: request.video_generate_audio,
    videoWebSearch: request.video_web_search,
    videoNsfwChecker: request.video_nsfw_checker,
    extraReferenceUrls: request.extra_reference_urls,
    videoReferenceUrls: request.video_reference_urls,
    audioReferenceUrls: request.audio_reference_urls,
    videoExtendSourcePath: request.video_extend_source_path || null,
    sourceOutputId: request.source_output_id,
    startFramePath: request.start_frame_path || null,
    endFramePath: request.end_frame_path || null,
    isLooping: request.is_looping || false,
    personGeneration: request.person_generation || 'allow_all',
  });

  await db.insert(studioGenerations).values({
    id: generationId,
    userId: scope.actorUserId,
    organizationId: scope.organizationId,
    customerId: scope.customerId,
    projectId: scope.projectId,
    createdByUserId: scope.actorUserId,
    workspaceId: scope.workspaceId,
    mode,
    prompt: rawPrompt,
    rawPrompt: request.prompt,
    studioPresetId: request.preset_id ?? null,
    studioPresetName,
    aspectRatio,
    provider: providerId,
    model,
    idempotencyKey: request.client_request_id ?? null,
    bulkJobId: null,
    sourceGenerationId,
    metadata: requestMetadata,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });

  for (const productId of productIds) {
    await db.insert(studioGenerationProducts).values({ generationId, productId });
  }
  for (const personaId of personaIds) {
    await db.insert(studioGenerationPersonas).values({ generationId, personaId });
  }
  for (const styleId of styleIds) {
    await db.insert(studioGenerationStyles).values({ generationId, styleId });
  }

  console.log(`[Studio Generation] Created generation record: id=${generationId}, mode=${mode}, provider=${providerId}, model=${model || 'default'}, prompt="${rawPrompt.slice(0, 80)}..."`);
  console.log(`[Studio Generation] References: products=${productIds.length}, personas=${personaIds.length}, styles=${styleIds.length}, extra_urls=${request.extra_reference_urls?.length || 0}, source_output=${request.source_output_id || 'none'}`);

  return { generationId, mode, prompt: rawPrompt };
}

export async function runStudioGeneration(generationId: string): Promise<void> {
  const [row] = await db.select({
    userId: studioGenerations.userId,
    organizationId: studioGenerations.organizationId,
    customerId: studioGenerations.customerId,
    projectId: studioGenerations.projectId,
    workspaceId: studioGenerations.workspaceId,
    mode: studioGenerations.mode,
    provider: studioGenerations.provider,
    model: studioGenerations.model,
    aspectRatio: studioGenerations.aspectRatio,
    prompt: studioGenerations.prompt,
    metadata: studioGenerations.metadata,
  })
    .from(studioGenerations)
    .where(eq(studioGenerations.id, generationId))
    .limit(1);

  if (!row) {
    console.error(`[Studio Generation] Generation not found for background processing: id=${generationId}`);
    return;
  }
  if (!row.organizationId || !row.workspaceId) {
    console.error(`[Studio Generation] Generation has no workspace scope: id=${generationId}`);
    return;
  }

  const scope = createPersistedStudioScope({
    actorUserId: row.userId,
    organizationId: row.organizationId,
    customerId: row.customerId,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
  });

  try {
    await executeStudioGenerationProcessing(scope, row, generationId);
  } catch (error) {
    console.error(`[Studio Generation] Background generation failed: id=${generationId}`, error);
  }
}

export async function executeStudioGeneration(
  scope: StudioScope,
  request: StudioGenerateRequest,
): Promise<StudioGenerateResult> {
  const { generationId, mode, prompt } = await createStudioGeneration(scope, request);
  const [row] = await db.select({
    userId: studioGenerations.userId,
    mode: studioGenerations.mode,
    provider: studioGenerations.provider,
    model: studioGenerations.model,
    aspectRatio: studioGenerations.aspectRatio,
    prompt: studioGenerations.prompt,
    metadata: studioGenerations.metadata,
  })
    .from(studioGenerations)
    .where(eq(studioGenerations.id, generationId))
    .limit(1);

  if (!row) {
    throw new StudioServiceError('Generation not found after creation', 'Generierung wurde nicht gefunden.');
  }

  await executeStudioGenerationProcessing(scope, row, generationId);

  const [completed] = await db.select({ status: studioGenerations.status, prompt: studioGenerations.prompt })
    .from(studioGenerations)
    .where(eq(studioGenerations.id, generationId))
    .limit(1);

  const outputs = await db.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.generationId, generationId));

  return {
    generationId,
    status: completed?.status || 'completed',
    mode,
    prompt: completed?.prompt || prompt,
    outputs: outputs.map((o) => ({
      id: o.id,
      variationIndex: o.variationIndex,
      filePath: o.filePath,
      fileName: o.fileName ?? undefined,
      mediaUrl: o.mediaUrl || toMediaUrl(o.filePath, { workspaceId: scope.workspaceId }),
      mimeType: o.mimeType || 'image/png',
      fileSize: o.fileSize ?? 0,
    })),
  };
}

interface GenerationRow {
  userId: string;
  mode: string;
  provider: string;
  model: string;
  aspectRatio: string;
  prompt: string | null;
  metadata: string | null;
}

async function sendStudioResultPush(input: {
  scope: StudioScope;
  generationId: string;
  status: 'completed' | 'failed';
  previewOutputId?: string;
}): Promise<void> {
  try {
    const { sendFailureAttentionPush, sendStudioCompletedPush } = await import('@/app/lib/mobile/push-devices');
    if (input.status === 'completed') {
      await sendStudioCompletedPush({
        userId: input.scope.actorUserId,
        workspaceId: input.scope.workspaceId,
        generationId: input.generationId,
        previewOutputId: input.previewOutputId,
      });
      return;
    }
    await sendFailureAttentionPush({
      userId: input.scope.actorUserId,
      workspaceId: input.scope.workspaceId,
      entityKind: 'studio',
      entityId: input.generationId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send Studio push notification.';
    console.warn('[Studio Generation] Push notification failed:', message);
  }
}

type StudioOutputInsert = typeof studioGenerationOutputs.$inferInsert;

async function insertStudioGenerationOutput(
  values: Omit<StudioOutputInsert, 'organizationId' | 'customerId' | 'projectId' | 'createdByUserId' | 'workspaceId'>,
) {
  const [scope] = await db.select({
    userId: studioGenerations.userId,
    organizationId: studioGenerations.organizationId,
    customerId: studioGenerations.customerId,
    projectId: studioGenerations.projectId,
    createdByUserId: studioGenerations.createdByUserId,
    workspaceId: studioGenerations.workspaceId,
  })
    .from(studioGenerations)
    .where(eq(studioGenerations.id, values.generationId))
    .limit(1);

  await db.insert(studioGenerationOutputs).values({
    ...values,
    organizationId: scope?.organizationId ?? null,
    customerId: scope?.customerId ?? null,
    projectId: scope?.projectId ?? null,
    createdByUserId: scope?.createdByUserId ?? scope?.userId ?? null,
    workspaceId: scope?.workspaceId ?? null,
  });
}

async function executeStudioGenerationProcessing(
  scope: StudioScope,
  generation: GenerationRow,
  generationId: string,
): Promise<void> {
  const parsedMeta = generation.metadata ? JSON.parse(generation.metadata) : {};
  const productIds: string[] = parsedMeta.productIds || [];
  const personaIds: string[] = parsedMeta.personaIds || [];
  const styleIds: string[] = parsedMeta.styleIds || [];
  const providerId = generation.provider;
  const mode = generation.mode;
  const aspectRatio = generation.aspectRatio;
  const rawPrompt = generation.prompt || '';
  const model = generation.model;
  const storageScope: EnvStorageScope = { userId: scope.actorUserId };

  console.log(`[Studio Generation] Starting background processing: id=${generationId}, mode=${mode}, provider=${providerId}`);

  try {
    const allReferenceImages: LoadedReferenceImage[] = [];

    const sourceOutputId = parsedMeta.sourceOutputId;
    if (sourceOutputId) {
      const sourceImg = await loadSourceOutputImage(scope, sourceOutputId);
      allReferenceImages.push(sourceImg);

      if (productIds.length === 0 && personaIds.length === 0 && styleIds.length === 0) {
        const sourceOutput = await getStudioOutputForUser(sourceOutputId, scope);
        if (sourceOutput) {
          const sourceRefs = await loadSourceOutputReferences(scope, sourceOutput.generationId);
          if (sourceRefs.product_ids.length > 0 || sourceRefs.persona_ids.length > 0 || sourceRefs.style_ids?.length > 0) {
            const srcProductImgs = await loadProductImages(scope, sourceRefs.product_ids);
            const srcPersonaImgs = await loadPersonaImages(scope, sourceRefs.persona_ids);
            const srcStyleImgs = await loadStyleImages(scope, sourceRefs.style_ids || []);
            for (const img of [...srcProductImgs, ...srcPersonaImgs, ...srcStyleImgs]) {
              if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
                allReferenceImages.push(img);
              }
            }
          }
        }
      }
    }

    const productImgs = await loadProductImages(scope, productIds);
    const personaImgs = await loadPersonaImages(scope, personaIds);
    const styleImgs = await loadStyleImages(scope, styleIds);
    for (const img of [...productImgs, ...personaImgs, ...styleImgs]) {
      if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
        allReferenceImages.push(img);
      }
    }

    const extraUrls = parsedMeta.extraReferenceUrls || [];
    if (extraUrls.length > 0) {
      const extraImgs = await loadExtraReferenceImages(scope, extraUrls);
      for (const img of extraImgs) {
        if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
          allReferenceImages.push(img);
        }
      }
    }

    const extraVideoReferences = mode === 'video' && providerId === SEEDANCE_PROVIDER_ID
      ? await loadExtraReferenceMedia(scope, parsedMeta.videoReferenceUrls || [], 'video')
      : [];
    const extraAudioReferences = mode === 'video' && providerId === SEEDANCE_PROVIDER_ID
      ? await loadExtraReferenceMedia(scope, parsedMeta.audioReferenceUrls || [], 'audio')
      : [];

    const { contextText, providerImages } = buildReferenceContextPrompt(allReferenceImages);
    console.log(`[Studio Generation] Reference images prepared: total=${allReferenceImages.length}, forProvider=${providerImages.length}, contextLength=${contextText.length}`);

    let composedPrompt = rawPrompt;
    const presetId = parsedMeta.presetId;
    if (presetId) {
      const presetFragment = await composePresetPromptFragment(presetId, scope);
      if (presetFragment) {
        composedPrompt = `## Preset — Visual Setting\n${presetFragment}\n\n## Instructions\n\n${rawPrompt}`.trim();
      }
    }

    await db.update(studioGenerations)
      .set({ status: 'generating', updatedAt: new Date() })
      .where(eq(studioGenerations.id, generationId));

    let outputs: StudioGenerationOutput[];

    if (mode === 'video') {
      outputs = await withStudioGenerationConcurrency('video', () => generateStudioVideo(
        generationId,
        composedPrompt,
        aspectRatio,
        providerImages,
        providerId,
        model,
        parsedMeta.videoResolution,
        parsedMeta.videoDuration,
        parsedMeta.startFramePath || null,
        parsedMeta.endFramePath || null,
        parsedMeta.isLooping || false,
        parsedMeta.personGeneration,
        extraVideoReferences,
        extraAudioReferences,
        parsedMeta.videoExtendSourcePath || null,
        {
          generateAudio: parsedMeta.videoGenerateAudio,
          webSearch: parsedMeta.videoWebSearch,
          nsfwChecker: parsedMeta.videoNsfwChecker,
        },
        storageScope,
        scope,
      ));
    } else if (mode === 'sound') {
      outputs = await generateStudioSound(
        generationId,
        composedPrompt,
        providerImages.slice(0, 10),
        providerId,
        model,
        parsedMeta.outputFormat,
        buildSoundContextPrompt(allReferenceImages),
        storageScope,
        scope,
      );
    } else {
      const count = Math.min(Math.max(parsedMeta.count || 1, 1), MAX_IMAGE_COUNT);
      outputs = await generateStudioImages(generationId, composedPrompt, count, aspectRatio, providerImages, providerId, model, {
        quality: parsedMeta.quality,
        outputFormat: parsedMeta.outputFormat,
        background: parsedMeta.background,
        imageSize: parsedMeta.imageSize,
      }, contextText, storageScope, scope);
    }

    await db.update(studioGenerations)
      .set({ status: 'completed', prompt: composedPrompt, updatedAt: new Date() })
      .where(eq(studioGenerations.id, generationId));

    await sendStudioResultPush({
      scope,
      generationId,
      status: 'completed',
      previewOutputId: outputs.find((output) => output.mimeType.startsWith('image/'))?.id,
    });

    console.log(`[Studio Generation] Completed: id=${generationId}, mode=${mode}, outputs=${outputs.length}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Studio Generation] Generation failed: id=${generationId}, error="${errorMessage}"`, error instanceof Error ? error.stack : error);
    const existingGeneration = await db.select({ metadata: studioGenerations.metadata })
      .from(studioGenerations)
      .where(eq(studioGenerations.id, generationId))
      .limit(1);
    const existingMetadata = existingGeneration[0]?.metadata
      ? JSON.parse(existingGeneration[0].metadata)
      : {};
    await db.update(studioGenerations)
      .set({ status: 'failed', metadata: JSON.stringify({ ...existingMetadata, error: errorMessage }), updatedAt: new Date() })
      .where(eq(studioGenerations.id, generationId));
    await sendStudioResultPush({ scope, generationId, status: 'failed' });
  }
}

async function generateStudioImages(
  generationId: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  referenceImages: ProviderReferenceImage[],
  providerId: string,
  model: string,
  options: { quality?: 'low' | 'medium' | 'high' | 'auto'; outputFormat?: 'png' | 'jpeg' | 'webp'; background?: 'transparent' | 'opaque' | 'auto'; imageSize?: string } | undefined,
  contextText: string | undefined,
  storageScope: EnvStorageScope | null | undefined,
  scope: StudioScope,
): Promise<StudioGenerationOutput[]> {
  const provider = getImageGenerationProvider(providerId);
  if (!provider) {
    throw new StudioServiceError(
      `Provider ${providerId} not found`,
      `Provider '${providerId}' wird nicht unterstützt. Verfügbare Provider: gemini, openai.`,
    );
  }

  const normalizedModel = providerId === 'gemini' ? normalizeGeminiImageModelId(model) : model;
  const validatedModel = provider.models.some((m) => m.id === normalizedModel)
    ? normalizedModel
    : (provider.models[0]?.id || normalizedModel);

  if (!provider.supportedAspectRatios.includes(aspectRatio)) {
    const supportedList = provider.supportedAspectRatios.join(', ');
    throw new StudioServiceError(
      `Aspect ratio ${aspectRatio} not supported`,
      `Seitenverhältnis '${aspectRatio}' wird von Provider '${providerId}' nicht unterstützt. Unterstützte Seitenverhältnisse: ${supportedList}.`,
      'INVALID_ASPECT_RATIO',
    );
  }

  const maxRefs = provider.getMaxReferenceImages(validatedModel);
  const limitedReferences = referenceImages.slice(0, maxRefs);
  const outputFormat = providerId === 'openai'
    ? normalizeOpenAIImageOutputFormat(options?.background, options?.outputFormat)
    : options?.outputFormat;

  await ensureStudioOutputsWorkspace(scope.storage);

  const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'studio';

  const generationJobs = Array.from({ length: count }, async (_, index): Promise<StudioGenerationOutput> => {
    try {
      console.log(`[Studio Generation] Generating image ${index + 1}/${count}: provider=${providerId}, model=${validatedModel}, aspectRatio=${aspectRatio}, refs=${limitedReferences.length}`);
      const result = await withStudioGenerationConcurrency('image', () => provider.generate({
        prompt,
        model: validatedModel,
        aspectRatio,
        referenceImages: limitedReferences,
        quality: options?.quality,
        outputFormat,
        background: options?.background,
        contextPrompt: contextText,
        imageSize: options?.imageSize,
        storageScope,
      }));

      const ext = extensionFromMime(result.mimeType);
      const outputFilename = generateOutputFilename(slug, index, ext);
      const outputPath = generateOutputPath(scope.storage, generationId, outputFilename);
      const outputBytes = Buffer.from(result.imageBytes, 'base64');

      console.log(`[Studio Generation] Image ${index + 1}/${count} generated: mime=${result.mimeType}, size=${outputBytes.length} bytes, file=${outputFilename}, usage=${JSON.stringify(result.usage || null)}`);
      await writeOutputFile(outputPath, outputBytes);
      console.log(`[Studio Generation] Image ${index + 1}/${count} written: path=${outputPath}, bytes=${outputBytes.length}, mediaUrl=${toMediaUrl(outputPath, { workspaceId: scope.workspaceId })}`);

      const outputId = randomUUID();
      const now = new Date();
      const outputMetadata = {
        provider: providerId,
        model: validatedModel,
        aspectRatio,
        quality: options?.quality,
        outputFormat,
        background: options?.background,
        imageSize: options?.imageSize,
        usage: result.usage,
      };
      await insertStudioGenerationOutput({
        id: outputId,
        generationId,
        variationIndex: index,
        type: 'image',
        filePath: outputPath,
        fileName: outputFilename,
        mediaUrl: toMediaUrl(outputPath, { workspaceId: scope.workspaceId }),
        fileSize: outputBytes.length,
        mimeType: result.mimeType,
        width: null,
        height: null,
        isFavorite: false,
        metadata: JSON.stringify(outputMetadata),
        createdAt: now,
      });
      console.log(`[Studio Generation] Output row inserted: generationId=${generationId}, outputId=${outputId}, variation=${index}, path=${outputPath}, mime=${result.mimeType}`);

      return {
        id: outputId,
        variationIndex: index,
        filePath: outputPath,
        fileName: outputFilename,
        mediaUrl: toMediaUrl(outputPath, { workspaceId: scope.workspaceId }),
        mimeType: result.mimeType,
        fileSize: outputBytes.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Image generation failed';
      console.error(`[Studio Generation] Image ${index + 1}/${count} failed: ${errorMsg}`, error instanceof Error ? error.stack : error);
      const errorOutputId = randomUUID();
      const now = new Date();
      await insertStudioGenerationOutput({
        id: errorOutputId,
        generationId,
        variationIndex: index,
        type: 'image',
        filePath: '',
        fileName: `failed-image-${index}`,
        mediaUrl: null,
        fileSize: null,
        mimeType: null,
        width: null,
        height: null,
        isFavorite: false,
        metadata: JSON.stringify({ error: errorMsg }),
        createdAt: now,
      });
      throw error;
    }
  });

  const results = await Promise.allSettled(generationJobs);
  const successfulOutputs: StudioGenerationOutput[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      successfulOutputs.push(result.value);
    }
  }

  if (successfulOutputs.length === 0) {
    throw new StudioServiceError(
      'All image generations failed',
      'Alle Bildgenerierungen sind fehlgeschlagen. Bitte versuche es erneut mit einem anderen Prompt oder Provider.',
    );
  }

  return successfulOutputs;
}

async function generateStudioSound(
  generationId: string,
  prompt: string,
  referenceImages: ProviderReferenceImage[],
  providerId: string,
  model: string | undefined,
  outputFormat: string | undefined,
  contextText: string | undefined,
  storageScope: EnvStorageScope | null | undefined,
  scope: StudioScope,
): Promise<StudioGenerationOutput[]> {
  if (providerId !== 'gemini') {
    throw new StudioServiceError(
      `Provider ${providerId} not supported for sound generation`,
      'Sound-Generierung unterstützt aktuell nur Gemini.',
    );
  }
  if (!prompt) {
    throw new StudioServiceError(
      'Prompt required for sound generation',
      'Ein Prompt ist für Sound-Generierung erforderlich.',
    );
  }

  const resolvedModel = model === LYRIA_PRO_MODEL_ID ? LYRIA_PRO_MODEL_ID : LYRIA_CLIP_MODEL_ID;
  const resolvedOutputFormat: SoundOutputFormat = outputFormat === 'wav' && resolvedModel === LYRIA_PRO_MODEL_ID ? 'wav' : 'mp3';
  const fullPrompt = contextText ? `${contextText}\n\n## Music prompt\n${prompt}` : prompt;
  const result = await withStudioGenerationConcurrency('sound', () => generateSound({
    prompt: fullPrompt,
    model: resolvedModel,
    outputFormat: resolvedOutputFormat,
    referenceImages: referenceImages.slice(0, 10),
    storageScope,
  }));

  await ensureStudioOutputsWorkspace(scope.storage);

  const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'sound';
  const ext = extensionFromMime(result.mimeType);
  const outputFilename = generateOutputFilename(slug, 0, ext === 'bin' ? resolvedOutputFormat : ext);
  const outputPath = generateOutputPath(scope.storage, generationId, outputFilename);
  await writeOutputFile(outputPath, result.audioBytes);

  const outputId = randomUUID();
  const now = new Date();
  await insertStudioGenerationOutput({
    id: outputId,
    generationId,
    variationIndex: 0,
    type: 'sound',
    filePath: outputPath,
    fileName: outputFilename,
    mediaUrl: toMediaUrl(outputPath, { workspaceId: scope.workspaceId }),
    fileSize: result.audioBytes.length,
    mimeType: result.mimeType,
    width: null,
    height: null,
    isFavorite: false,
    metadata: JSON.stringify(result.metadata),
    createdAt: now,
  });

  return [{
    id: outputId,
    variationIndex: 0,
    filePath: outputPath,
    fileName: outputFilename,
    mediaUrl: toMediaUrl(outputPath, { workspaceId: scope.workspaceId }),
    mimeType: result.mimeType,
    fileSize: result.audioBytes.length,
  }];
}

async function generateStudioVideo(
  generationId: string,
  prompt: string,
  aspectRatio: string,
  referenceImages: ProviderReferenceImage[],
  providerId: string,
  videoModel?: string,
  videoResolution?: '480p' | '720p' | '1080p' | '4k',
  videoDuration?: number,
  startFramePath?: string | null,
  endFramePath?: string | null,
  isLooping?: boolean,
  personGeneration?: 'allow_all' | 'allow_adult' | 'dont_allow',
  referenceVideos: ProviderReferenceMedia[] = [],
  referenceAudios: ProviderReferenceMedia[] = [],
  videoExtendSourcePath?: string | null,
  videoOptions?: {
    generateAudio?: boolean;
    webSearch?: boolean;
    nsfwChecker?: boolean;
  },
  storageScope?: EnvStorageScope | null,
  scope?: StudioScope,
): Promise<StudioGenerationOutput[]> {
  if (!prompt && !videoExtendSourcePath) {
    throw new StudioServiceError(
      'Prompt required for video generation',
      'Ein Prompt ist für Video-Generierung erforderlich.',
    );
  }

  if (scope) {
    await Promise.all(
      [startFramePath, endFramePath, videoExtendSourcePath]
        .filter((value): value is string => Boolean(value))
        .map((value) => assertStudioReferenceReadable(value, scope)),
    );
  }

  const hasFrameScenario = Boolean(startFramePath || endFramePath);
  const providerReferenceImages = hasFrameScenario ? [] : limitVideoProviderReferenceImages(providerId, referenceImages);
  const imageReferenceLimit = getVideoProviderImageReferenceLimit(providerId);
  if (referenceImages.length > providerReferenceImages.length) {
    const reason = hasFrameScenario ? 'first/last-frame mode is active' : `provider limit is ${imageReferenceLimit}`;
    console.log(`[Studio Generation] Video image references limited: provider=${providerId}, kept=${providerReferenceImages.length}, dropped=${referenceImages.length - providerReferenceImages.length}, reason=${reason}`);
  }

  const videoMode = videoExtendSourcePath ? 'extend_video' : hasFrameScenario ? 'frames_to_video' : (providerReferenceImages.length > 0 ? 'references_to_video' : 'text_to_video');
  console.log(`[Studio Generation] Generating video: provider=${providerId}, model=${videoModel || 'default'}, mode=${videoMode}, aspect=${aspectRatio}, refs=${providerReferenceImages.length}, startFrame=${startFramePath ? 'yes' : 'no'}, endFrame=${endFramePath ? 'yes' : 'no'}`);

  if (providerId === SEEDANCE_PROVIDER_ID) {
    return generateStudioSeedanceVideo(
      generationId,
      prompt,
      aspectRatio,
      providerReferenceImages,
      videoResolution,
      videoDuration,
      startFramePath,
      endFramePath,
      isLooping,
      referenceVideos,
      referenceAudios,
      videoOptions,
      storageScope,
      scope,
    );
  }

  const videoAspect = aspectRatio === '9:16' ? '9:16' as const : '16:9' as const;

  const hasImageInput = videoMode === 'frames_to_video' || videoMode === 'references_to_video';
  const effectivePersonGeneration: 'allow_all' | 'allow_adult' | 'dont_allow' =
    videoMode === 'extend_video'
      ? 'allow_all'
      : (hasImageInput && (!personGeneration || personGeneration === 'allow_all')) ? 'allow_adult' : (personGeneration || 'allow_all');

  const resolvedResolution = videoMode === 'extend_video' ? '720p' : videoResolution === '480p' ? '720p' : videoResolution || '720p';
  const needsMinDuration8 = videoMode === 'extend_video' || resolvedResolution === '1080p' || resolvedResolution === '4k' || videoMode === 'references_to_video';
  const effectiveDuration = needsMinDuration8 ? 8 : (videoDuration || 6);

  const requestBody: GenerateVideoRequestBody = {
    prompt,
    model: videoModel || 'veo-3.1-fast-generate-preview',
    mode: videoMode,
    aspectRatio: videoAspect,
    resolution: resolvedResolution,
    durationSeconds: effectiveDuration as GenerateVideoRequestBody['durationSeconds'],
    referenceImagePaths: [],
    startFramePath: videoMode === 'extend_video' ? undefined : startFramePath || undefined,
    endFramePath: videoMode === 'extend_video' ? undefined : isLooping ? undefined : (endFramePath || undefined),
    isLooping: videoMode === 'extend_video' ? false : isLooping || false,
    inputVideoPath: videoExtendSourcePath || undefined,
    personGeneration: effectivePersonGeneration,
    generateAudio: videoOptions?.generateAudio,
    storageScope,
    studioStorageScope: scope?.storage,
    studioGenerationId: generationId,
  };

  if (providerReferenceImages.length > 0) {
    const tempPaths: string[] = [];
    for (let i = 0; i < providerReferenceImages.length; i++) {
      const ref = providerReferenceImages[i];
      const ext = extensionFromMime(ref.mimeType);
      const tempFileName = `temp-ref-${generationId}-${i}.${ext}`;
      const tempPath = scope
        ? generateOutputPath(scope.storage, generationId, tempFileName)
        : tempFileName;
      const buffer = Buffer.from(ref.imageBytes, 'base64');
      await writeOutputFile(tempPath, buffer);
      tempPaths.push(tempPath);
    }
    requestBody.referenceImagePaths = tempPaths;
  }

  const videoResult = await generateVideo(requestBody, 'studio-generation', { userId: scope?.actorUserId });

  const outputId = randomUUID();
  const now = new Date();

  await insertStudioGenerationOutput({
    id: outputId,
    generationId,
    variationIndex: 0,
    type: 'video',
    filePath: videoResult.path,
    fileName: path.basename(videoResult.path),
    mediaUrl: videoResult.mediaUrl,
    fileSize: videoResult.fileSize,
    mimeType: videoResult.mimeType,
    width: null,
    height: null,
    isFavorite: false,
    metadata: JSON.stringify(videoResult.metadata),
    createdAt: now,
  });

  return [{
    id: outputId,
    variationIndex: 0,
    filePath: videoResult.path,
    fileName: path.basename(videoResult.path),
    mediaUrl: videoResult.mediaUrl,
    mimeType: videoResult.mimeType,
    fileSize: videoResult.fileSize,
  }];
}

async function loadSeedanceFrame(filePath: string, scope?: StudioScope): Promise<SeedanceReferenceMedia> {
  try {
    if (scope) await assertStudioReferenceReadable(filePath, scope);
    const file = await loadMediaReference(filePath, { userId: scope?.actorUserId, allowedTypes: ['image'] });
    return {
      imageBytes: file.imageBytes,
      mimeType: file.mimeType,
      fileName: file.fileName,
    };
  } catch (error) {
    throw new StudioServiceError(
      error instanceof Error ? error.message : `Frame file could not be loaded: ${filePath}`,
      `Frame-Datei '${filePath}' wurde nicht gefunden oder ist keine Datei.`,
    );
  }
}

function toSeedanceAspectRatio(aspectRatio: string): SeedanceAspectRatio {
  const allowed: SeedanceAspectRatio[] = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'adaptive'];
  return allowed.includes(aspectRatio as SeedanceAspectRatio) ? aspectRatio as SeedanceAspectRatio : '16:9';
}

function toSeedanceResolution(resolution?: '480p' | '720p' | '1080p' | '4k'): SeedanceResolution {
  if (resolution === '480p' || resolution === '720p' || resolution === '1080p') {
    return resolution;
  }
  return '720p';
}

async function generateStudioSeedanceVideo(
  generationId: string,
  prompt: string,
  aspectRatio: string,
  referenceImages: ProviderReferenceImage[],
  videoResolution?: '480p' | '720p' | '1080p' | '4k',
  videoDuration?: number,
  startFramePath?: string | null,
  endFramePath?: string | null,
  isLooping?: boolean,
  referenceVideos: ProviderReferenceMedia[] = [],
  referenceAudios: ProviderReferenceMedia[] = [],
  videoOptions?: {
    generateAudio?: boolean;
    webSearch?: boolean;
    nsfwChecker?: boolean;
  },
  storageScope?: EnvStorageScope | null,
  scope?: StudioScope,
): Promise<StudioGenerationOutput[]> {
  console.log(`[Studio Generation] Seedance video: refs=${referenceImages.length}, startFrame=${startFramePath ? 'yes' : 'no'}, endFrame=${endFramePath ? 'yes' : 'no'}, duration=${videoDuration || 6}s`);
  const firstFrame = startFramePath ? await loadSeedanceFrame(startFramePath, scope) : null;
  const lastFramePath = isLooping ? startFramePath : endFramePath;
  const lastFrame = lastFramePath ? await loadSeedanceFrame(lastFramePath, scope) : null;
  console.log(`[Studio Generation] Seedance frames loaded: first=${firstFrame ? `${firstFrame.mimeType} ${firstFrame.fileName}` : 'none'}, last=${lastFrame ? `${lastFrame.mimeType} ${lastFrame.fileName}` : 'none'}`);

  const hasFrameScenario = Boolean(firstFrame || lastFrame);
  const seedanceReferences: SeedanceReferenceMedia[] = hasFrameScenario
    ? []
    : referenceImages.map((ref, index) => ({
        imageBytes: ref.imageBytes,
        mimeType: ref.mimeType,
        fileName: `reference-${index}.${extensionFromMime(ref.mimeType)}`,
        kind: 'image',
      }));
  const seedanceVideos: SeedanceReferenceMedia[] = hasFrameScenario
    ? []
    : referenceVideos.slice(0, 3).map((ref, index) => ({
        imageBytes: ref.imageBytes,
        mimeType: ref.mimeType,
        fileName: ref.fileName || `reference-video-${index}.${extensionFromMime(ref.mimeType)}`,
        kind: 'video',
      }));
  const seedanceAudios: SeedanceReferenceMedia[] = hasFrameScenario
    ? []
    : referenceAudios.slice(0, 3).map((ref, index) => ({
        imageBytes: ref.imageBytes,
        mimeType: ref.mimeType,
        fileName: ref.fileName || `reference-audio-${index}.${extensionFromMime(ref.mimeType)}`,
        kind: 'audio',
      }));

  if (hasFrameScenario && (referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0)) {
    console.log(`[Studio Generation] Seedance: multimodal references dropped because first/last-frame mode is active (images=${referenceImages.length}, videos=${referenceVideos.length}, audio=${referenceAudios.length})`);
  }

  const videoResult = await generateSeedanceVideo({
    prompt,
    aspectRatio: toSeedanceAspectRatio(aspectRatio),
    resolution: toSeedanceResolution(videoResolution),
    durationSeconds: videoDuration,
    firstFrame,
    lastFrame,
    referenceImages: seedanceReferences,
    referenceVideos: seedanceVideos,
    referenceAudios: seedanceAudios,
    generateAudio: videoOptions?.generateAudio,
    webSearch: videoOptions?.webSearch,
    nsfwChecker: videoOptions?.nsfwChecker,
    caller: 'studio-generation',
    storageScope,
    studioStorageScope: scope?.storage,
    studioGenerationId: generationId,
  });

  const outputId = randomUUID();
  const now = new Date();
  await insertStudioGenerationOutput({
    id: outputId,
    generationId,
    variationIndex: 0,
    type: 'video',
    filePath: videoResult.path,
    fileName: path.basename(videoResult.path),
    mediaUrl: videoResult.mediaUrl,
    fileSize: videoResult.fileSize,
    mimeType: videoResult.mimeType,
    width: null,
    height: null,
    isFavorite: false,
    metadata: JSON.stringify(videoResult.metadata),
    createdAt: now,
  });

  return [{
    id: outputId,
    variationIndex: 0,
    filePath: videoResult.path,
    fileName: path.basename(videoResult.path),
    mediaUrl: videoResult.mediaUrl,
    mimeType: videoResult.mimeType,
    fileSize: videoResult.fileSize,
  }];
}

export interface ListStudioGenerationsOptions {
  limit?: number;
  offset?: number;
  creatorUserId?: string | null;
}

async function listStudioGenerationCreators(scope: StudioScope) {
  const rows = await db.select({
    userId: studioGenerations.userId,
    createdByUserId: studioGenerations.createdByUserId,
  })
    .from(studioGenerations)
    .where(generationVisibilityCondition(scope))
    .groupBy(studioGenerations.userId, studioGenerations.createdByUserId);

  const creatorIds = [...new Set(
    rows
      .map((row) => row.createdByUserId ?? row.userId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];

  if (creatorIds.length === 0) return [];

  const users = await db.select({
    id: user.id,
    name: user.name,
    email: user.email,
  })
    .from(user)
    .where(inArray(user.id, creatorIds));
  const usersById = new Map(users.map((row) => [row.id, row]));

  return creatorIds.map((id) => ({
    id,
    name: usersById.get(id)?.name ?? usersById.get(id)?.email ?? id,
    email: usersById.get(id)?.email ?? null,
  }));
}

export async function listStudioGenerations(scope: StudioScope, options: ListStudioGenerationsOptions = {}) {
  const limit = options.limit && options.limit > 0 ? options.limit : undefined;
  const offset = options.offset && options.offset > 0 ? options.offset : undefined;
  const visibility = generationVisibilityCondition(scope, options.creatorUserId);

  let query = db.select()
    .from(studioGenerations)
    .where(visibility)
    .orderBy(desc(studioGenerations.createdAt))
    .$dynamic();

  if (limit) {
    query = query.limit(limit);
  }
  if (offset) {
    query = query.offset(offset);
  }

  const [generations, totalResult, creators] = await Promise.all([
    query,
    db.select({ count: count() })
      .from(studioGenerations)
      .where(visibility),
    listStudioGenerationCreators(scope),
  ]);

  const results = await Promise.all(generations.map(async (gen) => {
    const outputs = await db.select()
      .from(studioGenerationOutputs)
      .where(eq(studioGenerationOutputs.generationId, gen.id))
      .orderBy(asc(studioGenerationOutputs.variationIndex), asc(studioGenerationOutputs.createdAt));

    const productRefs = await db.select({ productId: studioGenerationProducts.productId })
      .from(studioGenerationProducts)
      .where(eq(studioGenerationProducts.generationId, gen.id));

    const personaRefs = await db.select({ personaId: studioGenerationPersonas.personaId })
      .from(studioGenerationPersonas)
      .where(eq(studioGenerationPersonas.generationId, gen.id));

    const styleRefs = await db.select({ styleId: studioGenerationStyles.styleId })
      .from(studioGenerationStyles)
      .where(eq(studioGenerationStyles.generationId, gen.id));

    return {
      ...gen,
      outputs: outputs.map((o) => ({
        ...o,
        mediaUrl: o.filePath ? toMediaUrl(o.filePath, { workspaceId: scope.workspaceId }) : o.mediaUrl,
      })),
      product_ids: productRefs.map((r) => r.productId),
      persona_ids: personaRefs.map((r) => r.personaId),
      style_ids: styleRefs.map((r) => r.styleId),
    };
  }));

  return {
    generations: results,
    creators,
    total: totalResult[0]?.count ?? results.length,
    limit: limit ?? null,
    offset: offset ?? 0,
    hasMore: typeof limit === 'number' ? (offset ?? 0) + results.length < (totalResult[0]?.count ?? results.length) : false,
  };
}

export async function getStudioGeneration(generationId: string, scope: StudioScope) {
  const [generation] = await db.select()
    .from(studioGenerations)
    .where(and(eq(studioGenerations.id, generationId), generationVisibilityCondition(scope)));

  if (!generation) return null;

  const outputs = await db.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.generationId, generationId))
    .orderBy(asc(studioGenerationOutputs.variationIndex), asc(studioGenerationOutputs.createdAt));

  const productRefs = await db.select({ productId: studioGenerationProducts.productId })
    .from(studioGenerationProducts)
    .where(eq(studioGenerationProducts.generationId, generationId));

  const personaRefs = await db.select({ personaId: studioGenerationPersonas.personaId })
    .from(studioGenerationPersonas)
    .where(eq(studioGenerationPersonas.generationId, generationId));

  const styleRefs = await db.select({ styleId: studioGenerationStyles.styleId })
    .from(studioGenerationStyles)
    .where(eq(studioGenerationStyles.generationId, generationId));

  return {
    ...generation,
    outputs: outputs.map((o) => ({
      ...o,
      mediaUrl: o.filePath ? toMediaUrl(o.filePath, { workspaceId: scope.workspaceId }) : o.mediaUrl,
    })),
    product_ids: productRefs.map((r) => r.productId),
    persona_ids: personaRefs.map((r) => r.personaId),
    style_ids: styleRefs.map((r) => r.styleId),
  };
}

export async function setStudioOutputFavorite(
  generationId: string,
  outputId: string,
  isFavorite: boolean,
  scope: StudioScope,
) {
  const existing = await getStudioOutputForUser(outputId, scope);
  if (!existing || existing.generationId !== generationId) {
    throw new StudioServiceError('Output not found', 'Output nicht gefunden', 'NOT_FOUND');
  }

  const [updated] = await db
    .update(studioGenerationOutputs)
    .set({ isFavorite })
    .where(eq(studioGenerationOutputs.id, outputId))
    .returning();

  return updated;
}

export async function deleteStudioOutput(outputId: string, scope: StudioScope): Promise<{ success: boolean; generationDeleted: boolean }> {
  const [outputRow] = await db.select({
    id: studioGenerationOutputs.id,
    generationId: studioGenerationOutputs.generationId,
    filePath: studioGenerationOutputs.filePath,
  })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(and(eq(studioGenerationOutputs.id, outputId), generationVisibilityCondition(scope)))
    .limit(1);

  if (!outputRow) {
    throw new StudioServiceError('Output not found', 'Output nicht gefunden', 'NOT_FOUND');
  }

  if (outputRow.filePath) {
    try {
      const { deleteOutputFile } = await import('@/app/lib/integrations/studio-workspace');
      await deleteOutputFile(outputRow.filePath);
    } catch (err) {
      console.warn(`Failed to delete output file ${outputRow.filePath}:`, err);
    }
  }

  await db.delete(studioGenerationOutputs).where(eq(studioGenerationOutputs.id, outputId));

  const remainingOutputs = await db.select({ id: studioGenerationOutputs.id })
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.generationId, outputRow.generationId));

  const generationDeleted = remainingOutputs.length === 0;
  if (generationDeleted) {
    await db.delete(studioGenerations).where(eq(studioGenerations.id, outputRow.generationId));
  }

  return { success: true, generationDeleted };
}

export async function deleteStudioGeneration(generationId: string, scope: StudioScope) {
  const [generation] = await db.select()
    .from(studioGenerations)
    .where(and(eq(studioGenerations.id, generationId), generationVisibilityCondition(scope)));

  if (!generation) {
    throw new StudioServiceError('Generation not found', 'Generierung nicht gefunden', 'NOT_FOUND');
  }

  const outputs = await db.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.generationId, generationId));

  for (const output of outputs) {
    if (output.filePath) {
      try {
        const { deleteOutputFile } = await import('@/app/lib/integrations/studio-workspace');
        await deleteOutputFile(output.filePath);
      } catch (err) {
        console.warn(`Failed to delete output file ${output.filePath}:`, err);
      }
    }
  }

  await db.delete(studioGenerations).where(eq(studioGenerations.id, generationId));

  return { success: true };
}
