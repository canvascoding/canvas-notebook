import 'server-only';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '@/app/lib/db';
import {
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
import { eq, and, desc } from 'drizzle-orm';
import { getImageGenerationProvider } from '@/app/lib/integrations/image-generation-providers';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import {
  readAssetFile,
  ensureStudioOutputsWorkspace,
  generateOutputFilename,
  writeOutputFile,
  readOutputFile,
  readStudioReferenceFile,
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { generateVideo, type GenerateVideoRequestBody } from '@/app/lib/integrations/veo-generation-service';
import {
  generateSeedanceVideo,
  SEEDANCE_MODEL_ID,
  SEEDANCE_PROVIDER_ID,
  type SeedanceAspectRatio,
  type SeedanceReferenceImage,
  type SeedanceResolution,
} from '@/app/lib/integrations/seedance-generation-service';
import { fetchExternalResourceSafely } from '@/app/lib/security/safe-external-fetch';
import {
  resolveValidatedStudioAssetPath,
  resolveValidatedStudioOutputPath,
  resolveValidatedUserUploadStudioRefPath,
  resolveValidatedWorkspaceFilePath,
  resolveValidatedWorkspaceRelativePath,
  getWorkspaceRoot,
} from '@/app/lib/integrations/studio-paths';
import { getFileStats, readFile, readDataFile, getDataFileStats } from '@/app/lib/filesystem/workspace-files';

type ProviderReferenceImage = { imageBytes: string; mimeType: string };

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
  mode?: 'image' | 'video';
  product_ids?: string[];
  persona_ids?: string[];
  style_ids?: string[];
  preset_id?: string;
  aspect_ratio?: string;
  count?: number;
  provider?: string;
  model?: string;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  output_format?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
  source_output_id?: string;
  pi_session_id?: string;
  extra_reference_urls?: string[];
  video_resolution?: '480p' | '720p' | '1080p' | '4k';
  video_duration?: number;
  start_frame_path?: string;
  end_frame_path?: string;
  is_looping?: boolean;
  person_generation?: 'allow_all' | 'allow_adult' | 'dont_allow';
  video_generate_audio?: boolean;
  video_web_search?: boolean;
  video_nsfw_checker?: boolean;
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

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const EXTENSION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH);
}

function extensionFromMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType] || 'png';
}

function mimeFromPath(filePath: string) {
  return EXTENSION_MIME[path.posix.extname(filePath).toLowerCase()] || 'image/png';
}

async function loadProductImages(userId: string, productIds: string[]): Promise<LoadedReferenceImage[]> {
  if (productIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const productId of productIds) {
    const [product] = await db.select({ id: studioProducts.id, name: studioProducts.name, description: studioProducts.description })
      .from(studioProducts)
      .where(and(eq(studioProducts.id, productId), eq(studioProducts.userId, userId)));

    if (!product) {
      throw new StudioServiceError(
        `Product ${productId} not found`,
        `Produkt '${productId}' wurde gelöscht. Bitte entferne diese Referenz und wähle ein anderes Produkt. Verwende studio_list_products um verfügbare Produkte zu sehen.`,
        'NOT_FOUND',
      );
    }

    const productImages = await db.select()
      .from(studioProductImages)
      .where(eq(studioProductImages.productId, productId));

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

async function loadPersonaImages(userId: string, personaIds: string[]): Promise<LoadedReferenceImage[]> {
  if (personaIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const personaId of personaIds) {
    const [persona] = await db.select({ id: studioPersonas.id, name: studioPersonas.name, description: studioPersonas.description })
      .from(studioPersonas)
      .where(and(eq(studioPersonas.id, personaId), eq(studioPersonas.userId, userId)));

    if (!persona) {
      throw new StudioServiceError(
        `Persona ${personaId} not found`,
        `Persona '${personaId}' wurde gelöscht. Bitte entferne diese Referenz und wähle eine andere Persona. Verwende studio_list_personas um verfügbare Personen zu sehen.`,
        'NOT_FOUND',
      );
    }

    const personaImages = await db.select()
      .from(studioPersonaImages)
      .where(eq(studioPersonaImages.personaId, personaId));

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

async function loadStyleImages(userId: string, styleIds: string[]): Promise<LoadedReferenceImage[]> {
  if (styleIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const styleId of styleIds) {
    const [style] = await db.select({ id: studioStyles.id, name: studioStyles.name, description: studioStyles.description })
      .from(studioStyles)
      .where(and(eq(studioStyles.id, styleId), eq(studioStyles.userId, userId)));

    if (!style) {
      throw new StudioServiceError(
        `Style ${styleId} not found`,
        `Style '${styleId}' wurde gelöscht. Bitte entferne diese Referenz und wähle einen anderen Style.`,
        'NOT_FOUND',
      );
    }

    const styleImages = await db.select()
      .from(studioStyleImages)
      .where(eq(studioStyleImages.styleId, styleId));

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

export async function getStudioOutputForUser(outputId: string, userId: string) {
  const [output] = await db.select({
    id: studioGenerationOutputs.id,
    generationId: studioGenerationOutputs.generationId,
    filePath: studioGenerationOutputs.filePath,
    mimeType: studioGenerationOutputs.mimeType,
    width: studioGenerationOutputs.width,
    height: studioGenerationOutputs.height,
  })
    .from(studioGenerationOutputs)
    .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
    .where(and(eq(studioGenerationOutputs.id, outputId), eq(studioGenerations.userId, userId)))
    .limit(1);

  return output ?? null;
}

async function loadSourceOutputImage(userId: string, sourceOutputId: string): Promise<LoadedReferenceImage> {
  const output = await getStudioOutputForUser(sourceOutputId, userId);

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

async function composePresetPromptFragment(presetId: string): Promise<string> {
  const [preset] = await db.select()
    .from(studioPresets)
    .where(eq(studioPresets.id, presetId));

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

async function loadSourceOutputReferences(userId: string, sourceGenerationId: string): Promise<{
  product_ids: string[];
  persona_ids: string[];
  style_ids: string[];
}> {
  const [generation] = await db.select({ id: studioGenerations.id })
    .from(studioGenerations)
    .where(and(eq(studioGenerations.id, sourceGenerationId), eq(studioGenerations.userId, userId)))
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

async function loadExtraReferenceImages(userId: string, urls: string[]): Promise<LoadedReferenceImage[]> {
  if (urls.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const rawUrl of urls) {
    const url = rawUrl.trim();
    if (!url) continue;

    try {
      let buffer: Buffer;
      let contentType: string;
      let sourceId = url;
      let fileName = url.split('/').pop() || 'extra-reference.png';

      const localPath = normalizeLocalExtraReference(url);
      if (localPath?.kind === 'studio_reference') {
        const fileId = localPath.referenceId;
        if (!isSafeReferenceId(fileId)) {
          throw new Error('Invalid local reference URL');
        }

        buffer = await readStudioReferenceFile(userId, fileId);
        contentType = mimeFromPath(fileId);
        sourceId = localPath.sourceId;
        fileName = fileId;
      } else if (localPath?.kind === 'studio_output') {
        const fullPath = resolveValidatedStudioOutputPath(localPath.relativePath);
        if (!fullPath) {
          throw new Error('Invalid studio output reference path');
        }

        buffer = await fs.readFile(fullPath);
        contentType = mimeFromPath(localPath.relativePath);
        sourceId = localPath.sourceId;
        fileName = localPath.relativePath.split('/').pop() || fileName;
      } else if (localPath?.kind === 'studio_asset') {
        const fullPath = resolveValidatedStudioAssetPath(localPath.relativePath);
        if (!fullPath) {
          throw new Error('Invalid studio asset reference path');
        }

        buffer = await fs.readFile(fullPath);
        contentType = mimeFromPath(localPath.relativePath);
        sourceId = localPath.sourceId;
        fileName = localPath.relativePath.split('/').pop() || fileName;
      } else if (localPath?.kind === 'user_upload') {
        const fullPath = resolveValidatedUserUploadStudioRefPath(localPath.relativePath);
        if (!fullPath) {
          throw new Error('Invalid user upload reference path');
        }

        buffer = await fs.readFile(fullPath);
        contentType = mimeFromPath(localPath.relativePath);
        sourceId = localPath.sourceId;
        fileName = localPath.relativePath.split('/').pop() || fileName;
      } else if (localPath?.kind === 'workspace_file') {
        const fullPath = resolveValidatedWorkspaceFilePath(localPath.absolutePath);
        if (!fullPath) {
          throw new Error('Invalid workspace file reference path');
        }

        buffer = await fs.readFile(fullPath);
        contentType = mimeFromPath(localPath.absolutePath);
        sourceId = localPath.sourceId;
        fileName = localPath.absolutePath.split('/').pop() || fileName;
      } else if (localPath?.kind === 'workspace_relative') {
        const fullPath = resolveValidatedWorkspaceRelativePath(localPath.relativePath);
        if (!fullPath) {
          throw new Error('Invalid workspace reference path');
        }

        buffer = await fs.readFile(fullPath);
        contentType = mimeFromPath(localPath.relativePath);
        sourceId = localPath.sourceId;
        fileName = localPath.relativePath.split('/').pop() || fileName;
      } else {
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('Unsupported local reference path');
        }

        const response = await fetchExternalResourceSafely(url, { maxBytes: 10 * 1024 * 1024, timeoutMs: 30000 });
        buffer = response.buffer;
        contentType = response.contentType || 'image/png';
      }
      
      images.push({
        imageBytes: buffer.toString('base64'),
        mimeType: contentType.startsWith('image/') ? contentType : 'image/png',
        width: null,
        height: null,
        fileName,
        source: 'extra_url',
        sourceId,
        sourceName: 'Extra Reference',
      });
    } catch (error) {
      console.warn(`[Studio Generation] Failed to load extra reference image from ${url}:`, error);
    }
  }

  return images;
}

type LocalExtraReference =
  | { kind: 'studio_reference'; referenceId: string; sourceId: string }
  | { kind: 'studio_output'; relativePath: string; sourceId: string }
  | { kind: 'studio_asset'; relativePath: string; sourceId: string }
  | { kind: 'user_upload'; relativePath: string; sourceId: string }
  | { kind: 'workspace_file'; absolutePath: string; sourceId: string }
  | { kind: 'workspace_relative'; relativePath: string; sourceId: string };

function normalizeLocalExtraReference(rawUrl: string): LocalExtraReference | null {
  const pathOnly = getLocalReferencePath(rawUrl);
  if (!pathOnly) return null;

  if (pathOnly.startsWith('/api/studio/references/')) {
    const referenceId = decodePath(pathOnly.slice('/api/studio/references/'.length));
    return referenceId ? { kind: 'studio_reference', referenceId, sourceId: rawUrl } : null;
  }

  const studioMediaPath = pathOnly.startsWith('/api/studio/media/')
    ? decodePath(pathOnly.slice('/api/studio/media/'.length))
    : decodePath(pathOnly.replace(/^\/+/, ''));

  if (studioMediaPath.startsWith('studio/outputs/')) {
    return {
      kind: 'studio_output',
      relativePath: studioMediaPath.slice('studio/outputs/'.length),
      sourceId: rawUrl,
    };
  }

  if (studioMediaPath.startsWith('studio/assets/')) {
    return {
      kind: 'studio_asset',
      relativePath: studioMediaPath.slice('studio/assets/'.length),
      sourceId: rawUrl,
    };
  }

  if (studioMediaPath.startsWith('user-uploads/studio-references/')) {
    return {
      kind: 'user_upload',
      relativePath: studioMediaPath.slice('user-uploads/studio-references/'.length),
      sourceId: rawUrl,
    };
  }

  if (studioMediaPath.startsWith('products/') || studioMediaPath.startsWith('personas/') || studioMediaPath.startsWith('styles/') || studioMediaPath.startsWith('presets/') || studioMediaPath.startsWith('references/')) {
    return {
      kind: 'studio_asset',
      relativePath: studioMediaPath,
      sourceId: rawUrl,
    };
  }

  if (studioMediaPath.startsWith('studio-gen-')) {
    return {
      kind: 'studio_output',
      relativePath: studioMediaPath,
      sourceId: rawUrl,
    };
  }

  // Handle /api/media/ paths → resolve as workspace-relative file
  if (pathOnly.startsWith('/api/media/')) {
    const relativePath = decodePath(pathOnly.slice('/api/media/'.length));
    return { kind: 'workspace_relative', relativePath, sourceId: rawUrl };
  }

  // Handle absolute workspace filesystem paths (e.g. /data/workspace/...)
  const workspaceRoot = getWorkspaceRoot();
  if (pathOnly.startsWith(workspaceRoot + '/') || pathOnly.startsWith(workspaceRoot + path.sep)) {
    return { kind: 'workspace_file', absolutePath: pathOnly, sourceId: rawUrl };
  }

  return null;
}

function getLocalReferencePath(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.pathname;
  } catch {
    return rawUrl.split(/[?#]/, 1)[0] || null;
  }
}

function decodePath(filePath: string) {
  return filePath
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function isSafeReferenceId(referenceId: string) {
  return referenceId.length > 0 && !referenceId.includes('/') && !referenceId.includes('\\') && !referenceId.includes('..');
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

export async function executeStudioGeneration(
  userId: string,
  request: StudioGenerateRequest,
): Promise<StudioGenerateResult> {
  const mode = request.mode || 'image';
  const providerId = request.provider || (mode === 'video' ? 'veo' : 'gemini');
  const aspectRatio = request.aspect_ratio || '1:1';
  const rawPrompt = sanitizePrompt(request.prompt);
  const productIds = (request.product_ids || []).slice(0, MAX_PRODUCTS);
  const personaIds = (request.persona_ids || []).slice(0, MAX_PERSONAS);
  const styleIds = (request.style_ids || []).slice(0, MAX_STYLES);

  if (!rawPrompt && productIds.length === 0 && personaIds.length === 0 && styleIds.length === 0 && !request.source_output_id && !(request.extra_reference_urls?.length)) {
    throw new StudioServiceError(
      'Prompt or reference required',
      'Ein Prompt oder mindestens ein Referenz-Bild (Produkt/Persona) ist erforderlich.',
    );
  }

  const generationId = randomUUID();
  const now = new Date();
  let sourceGenerationId: string | null = null;

  const defaultModel = providerId === 'openai' ? 'gpt-image-1.5' : 'gemini-3.1-flash-image-preview';
  const videoDefaultModel = providerId === SEEDANCE_PROVIDER_ID ? SEEDANCE_MODEL_ID : 'veo-3.1-fast-generate-preview';
  const model = request.mode === 'video'
    ? (request.model || videoDefaultModel)
    : (request.model || defaultModel);

  if (request.source_output_id) {
    const sourceOutput = await getStudioOutputForUser(request.source_output_id, userId);
    sourceGenerationId = sourceOutput?.generationId ?? null;
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
    videoResolution: request.video_resolution,
    videoDuration: request.video_duration,
    videoGenerateAudio: request.video_generate_audio,
    videoWebSearch: request.video_web_search,
    videoNsfwChecker: request.video_nsfw_checker,
    extraReferenceUrls: request.extra_reference_urls,
    sourceOutputId: request.source_output_id,
  });

  await db.insert(studioGenerations).values({
    id: generationId,
    userId,
    mode,
    prompt: rawPrompt,
    rawPrompt: request.prompt,
    studioPresetId: request.preset_id ?? null,
    aspectRatio,
    provider: providerId,
    model,
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

  try {
    const allReferenceImages: LoadedReferenceImage[] = [];

    if (request.source_output_id) {
      const sourceImg = await loadSourceOutputImage(userId, request.source_output_id);
      allReferenceImages.push(sourceImg);

      if (productIds.length === 0 && personaIds.length === 0 && styleIds.length === 0) {
        const sourceOutput = await getStudioOutputForUser(request.source_output_id, userId);
        if (sourceOutput) {
          const sourceRefs = await loadSourceOutputReferences(userId, sourceOutput.generationId);
          if (sourceRefs.product_ids.length > 0 || sourceRefs.persona_ids.length > 0 || sourceRefs.style_ids?.length > 0) {
            const productImgs = await loadProductImages(userId, sourceRefs.product_ids);
            const personaImgs = await loadPersonaImages(userId, sourceRefs.persona_ids);
            const styleImgs = await loadStyleImages(userId, sourceRefs.style_ids || []);
            for (const img of [...productImgs, ...personaImgs, ...styleImgs]) {
              if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
                allReferenceImages.push(img);
              }
            }
          }
        }
      }
    }

    const productImgs = await loadProductImages(userId, productIds);
    const personaImgs = await loadPersonaImages(userId, personaIds);
    const styleImgs = await loadStyleImages(userId, styleIds);
    for (const img of [...productImgs, ...personaImgs, ...styleImgs]) {
      if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
        allReferenceImages.push(img);
      }
    }

    // Load extra reference images from URLs
    const extraUrls = request.extra_reference_urls || [];
    if (extraUrls.length > 0) {
      const extraImgs = await loadExtraReferenceImages(userId, extraUrls);
      for (const img of extraImgs) {
        if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
          allReferenceImages.push(img);
        }
      }
    }

    // Build structured context prompt for all references
    const { contextText, providerImages } = buildReferenceContextPrompt(allReferenceImages);

    // Compose the final prompt with structured Markdown sections
    let composedPrompt = rawPrompt;
    if (request.preset_id) {
      const presetFragment = await composePresetPromptFragment(request.preset_id);
      if (presetFragment) {
        composedPrompt = `## Preset — Visual Setting\n${presetFragment}\n\n## Instructions\n\n${rawPrompt}`.trim();
      }
    }

    await db.update(studioGenerations)
      .set({ status: 'generating', updatedAt: new Date() })
      .where(eq(studioGenerations.id, generationId));

    let outputs: StudioGenerationOutput[];

    if (mode === 'video') {
      outputs = await generateStudioVideo(
        generationId,
        composedPrompt,
        aspectRatio,
        providerImages,
        providerId,
        model,
        request.video_resolution,
        request.video_duration,
        request.start_frame_path || null,
        request.end_frame_path || null,
        request.is_looping || false,
        request.person_generation,
        {
          generateAudio: request.video_generate_audio,
          webSearch: request.video_web_search,
          nsfwChecker: request.video_nsfw_checker,
        },
      );
    } else {
      const count = Math.min(Math.max(request.count || 4, 1), MAX_IMAGE_COUNT);
      outputs = await generateStudioImages(generationId, composedPrompt, count, aspectRatio, providerImages, providerId, model, {
        quality: request.quality,
        outputFormat: request.output_format,
        background: request.background,
      }, contextText);
    }

    await db.update(studioGenerations)
      .set({ status: 'completed', prompt: composedPrompt, updatedAt: new Date() })
      .where(eq(studioGenerations.id, generationId));

    return { generationId, status: 'completed', mode, prompt: composedPrompt, outputs };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
    throw error;
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
  options?: { quality?: 'low' | 'medium' | 'high' | 'auto'; outputFormat?: 'png' | 'jpeg' | 'webp'; background?: 'transparent' | 'opaque' | 'auto' },
  contextText?: string,
): Promise<StudioGenerationOutput[]> {
  const provider = getImageGenerationProvider(providerId);
  if (!provider) {
    throw new StudioServiceError(
      `Provider ${providerId} not found`,
      `Provider '${providerId}' wird nicht unterstützt. Verfügbare Provider: gemini, openai.`,
    );
  }

  const validatedModel = provider.models.some((m) => m.id === model) ? model : (provider.models[0]?.id || model);

  if (!provider.supportedAspectRatios.includes(aspectRatio)) {
    throw new StudioServiceError(
      `Aspect ratio ${aspectRatio} not supported`,
      `Seitenverhältnis '${aspectRatio}' wird von Provider '${providerId}' nicht unterstützt.`,
    );
  }

  const maxRefs = provider.getMaxReferenceImages(validatedModel);
  const limitedReferences = referenceImages.slice(0, maxRefs);

  await ensureStudioOutputsWorkspace();

  const slug = prompt.slice(0, 40).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'studio';

  const generationJobs = Array.from({ length: count }, async (_, index): Promise<StudioGenerationOutput> => {
    try {
      const result = await provider.generate({
        prompt,
        model: validatedModel,
        aspectRatio,
        referenceImages: limitedReferences,
        quality: options?.quality,
        outputFormat: options?.outputFormat,
        background: options?.background,
        contextPrompt: contextText,
      });

      const ext = extensionFromMime(result.mimeType);
      const outputFilename = generateOutputFilename(slug, index, ext);
      const outputPath = outputFilename;
      const outputBytes = Buffer.from(result.imageBytes, 'base64');

      await writeOutputFile(outputPath, outputBytes);

      const outputId = randomUUID();
      const now = new Date();
      const outputMetadata = {
        provider: providerId,
        model: validatedModel,
        aspectRatio,
        quality: options?.quality,
        outputFormat: options?.outputFormat,
        background: options?.background,
        usage: result.usage,
      };
      await db.insert(studioGenerationOutputs).values({
        id: outputId,
        generationId,
        variationIndex: index,
        type: 'image',
        filePath: outputPath,
        fileName: outputFilename,
        mediaUrl: toMediaUrl(outputPath),
        fileSize: outputBytes.length,
        mimeType: result.mimeType,
        width: null,
        height: null,
        isFavorite: false,
        metadata: JSON.stringify(outputMetadata),
        createdAt: now,
      });

      return {
        id: outputId,
        variationIndex: index,
        filePath: outputPath,
        fileName: outputFilename,
        mediaUrl: toMediaUrl(outputPath),
        mimeType: result.mimeType,
        fileSize: outputBytes.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Image generation failed';
      const errorOutputId = randomUUID();
      const now = new Date();
      await db.insert(studioGenerationOutputs).values({
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
  videoOptions?: {
    generateAudio?: boolean;
    webSearch?: boolean;
    nsfwChecker?: boolean;
  },
): Promise<StudioGenerationOutput[]> {
  if (!prompt) {
    throw new StudioServiceError(
      'Prompt required for video generation',
      'Ein Prompt ist für Video-Generierung erforderlich.',
    );
  }

  if (providerId === SEEDANCE_PROVIDER_ID) {
    return generateStudioSeedanceVideo(
      generationId,
      prompt,
      aspectRatio,
      referenceImages,
      videoResolution,
      videoDuration,
      startFramePath,
      endFramePath,
      isLooping,
      videoOptions,
    );
  }

  const videoAspect = aspectRatio === '9:16' ? '9:16' as const : '16:9' as const;

  const requestBody: GenerateVideoRequestBody = {
    prompt,
    model: videoModel || 'veo-3.1-fast-generate-preview',
    mode: (startFramePath || endFramePath) ? 'frames_to_video' : (referenceImages.length > 0 ? 'references_to_video' : 'text_to_video'),
    aspectRatio: videoAspect,
    resolution: videoResolution === '480p' ? '720p' : videoResolution || '720p',
    durationSeconds: (videoDuration || 6) as GenerateVideoRequestBody['durationSeconds'],
    referenceImagePaths: [],
    startFramePath: startFramePath || undefined,
    endFramePath: isLooping ? undefined : (endFramePath || undefined),
    isLooping: isLooping || false,
    personGeneration: personGeneration || 'allow_all',
  };

  if (referenceImages.length > 0) {
    const tempPaths: string[] = [];
    for (let i = 0; i < referenceImages.length; i++) {
      const ref = referenceImages[i];
      const ext = extensionFromMime(ref.mimeType);
      const tempPath = `temp-ref-${generationId}-${i}.${ext}`;
      const buffer = Buffer.from(ref.imageBytes, 'base64');
      await writeOutputFile(tempPath, buffer);
      tempPaths.push(tempPath);
    }
    requestBody.referenceImagePaths = tempPaths;
  }

  const videoResult = await generateVideo(requestBody, 'studio-generation');

  const outputId = randomUUID();
  const now = new Date();
  const videoPath = videoResult.path;
  const fs = await import('node:fs/promises');
  let fileSize: number | null = null;
  try {
    const stat = await fs.stat(videoPath);
    fileSize = stat.size;
  } catch {}

  await db.insert(studioGenerationOutputs).values({
    id: outputId,
    generationId,
    variationIndex: 0,
    type: 'video',
    filePath: videoPath,
    fileName: path.basename(videoPath),
    mediaUrl: videoResult.mediaUrl,
    fileSize,
    mimeType: 'video/mp4',
    width: null,
    height: null,
    isFavorite: false,
    metadata: null,
    createdAt: now,
  });

  return [{
    id: outputId,
    variationIndex: 0,
    filePath: videoPath,
    fileName: path.basename(videoPath),
    mediaUrl: videoResult.mediaUrl,
    mimeType: 'video/mp4',
    fileSize: fileSize ?? 0,
  }];
}

async function loadSeedanceFrame(filePath: string): Promise<SeedanceReferenceImage> {
  let stats;
  let content;
  try {
    stats = await getFileStats(filePath);
    content = await readFile(filePath);
  } catch {
    stats = await getDataFileStats(filePath);
    content = await readDataFile(filePath);
  }

  if (!stats.isFile) {
    throw new StudioServiceError(
      `Not a file: ${filePath}`,
      `Frame-Datei '${filePath}' wurde nicht gefunden oder ist keine Datei.`,
    );
  }

  return {
    imageBytes: content.toString('base64'),
    mimeType: mimeFromPath(filePath),
    fileName: filePath.split('/').pop() || 'frame.png',
  };
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
  videoOptions?: {
    generateAudio?: boolean;
    webSearch?: boolean;
    nsfwChecker?: boolean;
  },
): Promise<StudioGenerationOutput[]> {
  const firstFrame = startFramePath ? await loadSeedanceFrame(startFramePath) : null;
  const lastFramePath = isLooping ? startFramePath : endFramePath;
  const lastFrame = lastFramePath ? await loadSeedanceFrame(lastFramePath) : null;

  const seedanceReferences: SeedanceReferenceImage[] = referenceImages.map((ref, index) => ({
    imageBytes: ref.imageBytes,
    mimeType: ref.mimeType,
    fileName: `reference-${index}.${extensionFromMime(ref.mimeType)}`,
  }));

  const videoResult = await generateSeedanceVideo({
    prompt,
    aspectRatio: toSeedanceAspectRatio(aspectRatio),
    resolution: toSeedanceResolution(videoResolution),
    durationSeconds: videoDuration,
    firstFrame,
    lastFrame,
    referenceImages: seedanceReferences,
    generateAudio: videoOptions?.generateAudio,
    webSearch: videoOptions?.webSearch,
    nsfwChecker: videoOptions?.nsfwChecker,
    caller: 'studio-generation',
  });

  const outputId = randomUUID();
  const now = new Date();
  await db.insert(studioGenerationOutputs).values({
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

export async function listStudioGenerations(userId: string) {
  const generations = await db.select()
    .from(studioGenerations)
    .where(eq(studioGenerations.userId, userId))
    .orderBy(desc(studioGenerations.createdAt));

  const results = await Promise.all(generations.map(async (gen) => {
    const outputs = await db.select()
      .from(studioGenerationOutputs)
      .where(eq(studioGenerationOutputs.generationId, gen.id));

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
        mediaUrl: o.filePath ? toMediaUrl(o.filePath) : o.mediaUrl,
      })),
      product_ids: productRefs.map((r) => r.productId),
      persona_ids: personaRefs.map((r) => r.personaId),
      style_ids: styleRefs.map((r) => r.styleId),
    };
  }));

  return results;
}

export async function getStudioGeneration(generationId: string, userId: string) {
  const [generation] = await db.select()
    .from(studioGenerations)
    .where(and(eq(studioGenerations.id, generationId), eq(studioGenerations.userId, userId)));

  if (!generation) return null;

  const outputs = await db.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.generationId, generationId));

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
      mediaUrl: o.filePath ? toMediaUrl(o.filePath) : o.mediaUrl,
    })),
    product_ids: productRefs.map((r) => r.productId),
    persona_ids: personaRefs.map((r) => r.personaId),
    style_ids: styleRefs.map((r) => r.styleId),
  };
}

export async function deleteStudioGeneration(generationId: string, userId: string) {
  const [generation] = await db.select()
    .from(studioGenerations)
    .where(and(eq(studioGenerations.id, generationId), eq(studioGenerations.userId, userId)));

  if (!generation) {
    throw new StudioServiceError('Generation not found', 'Generierung nicht gefunden', 'NOT_FOUND');
  }

  const outputs = await db.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.generationId, generationId));

  for (const output of outputs) {
    if (output.filePath) {
      try {
        const { deleteFile } = await import('@/app/lib/filesystem/workspace-files');
        await deleteFile(output.filePath);
      } catch {}
    }
  }

  await db.delete(studioGenerations).where(eq(studioGenerations.id, generationId));

  return { success: true };
}
