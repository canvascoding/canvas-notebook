import 'server-only';

import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import {
  studioProducts,
  studioProductImages,
  studioPersonas,
  studioPersonaImages,
  studioPresets,
  studioGenerations,
  studioGenerationOutputs,
  studioGenerationProducts,
  studioGenerationPersonas,
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
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import { generateVideo, type GenerateVideoRequestBody } from '@/app/lib/integrations/veo-generation-service';

type ProviderReferenceImage = { imageBytes: string; mimeType: string };

interface LoadedReferenceImage {
  imageBytes: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileName: string;
  source: 'product' | 'persona' | 'source_output' | 'extra_url';
  sourceId: string;
  sourceName: string;
  description?: string;
}

export interface StudioGenerateRequest {
  prompt: string;
  mode?: 'image' | 'video';
  product_ids?: string[];
  persona_ids?: string[];
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
}

export interface StudioGenerationOutput {
  id: string;
  variationIndex: number;
  filePath: string;
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
const MAX_IMAGE_COUNT = 4;

const PRESET_BLOCK_ORDER = ['lighting', 'camera', 'background', 'props', 'subject'];
const MAX_PROMPT_LENGTH = 4000;

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH);
}

function extensionFromMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType] || 'png';
}

async function loadProductImages(productIds: string[]): Promise<LoadedReferenceImage[]> {
  if (productIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const productId of productIds) {
    const [product] = await db.select({ id: studioProducts.id, name: studioProducts.name, description: studioProducts.description })
      .from(studioProducts)
      .where(eq(studioProducts.id, productId));

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

async function loadPersonaImages(personaIds: string[]): Promise<LoadedReferenceImage[]> {
  if (personaIds.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const personaId of personaIds) {
    const [persona] = await db.select({ id: studioPersonas.id, name: studioPersonas.name, description: studioPersonas.description })
      .from(studioPersonas)
      .where(eq(studioPersonas.id, personaId));

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

async function loadSourceOutputImage(sourceOutputId: string): Promise<LoadedReferenceImage> {
  const [output] = await db.select()
    .from(studioGenerationOutputs)
    .where(eq(studioGenerationOutputs.id, sourceOutputId));

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

async function loadSourceOutputReferences(sourceGenerationId: string): Promise<{
  product_ids: string[];
  persona_ids: string[];
}> {
  const productRows = await db.select({ productId: studioGenerationProducts.productId })
    .from(studioGenerationProducts)
    .where(eq(studioGenerationProducts.generationId, sourceGenerationId));

  const personaRows = await db.select({ personaId: studioGenerationPersonas.personaId })
    .from(studioGenerationPersonas)
    .where(eq(studioGenerationPersonas.generationId, sourceGenerationId));

  return {
    product_ids: productRows.map((r) => r.productId),
    persona_ids: personaRows.map((r) => r.personaId),
  };
}

async function loadExtraReferenceImages(urls: string[]): Promise<LoadedReferenceImage[]> {
  if (urls.length === 0) return [];

  const images: LoadedReferenceImage[] = [];

  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        throw new Error(`Failed to fetch image from ${url}: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = response.headers.get('content-type') || 'image/png';
      
      images.push({
        imageBytes: buffer.toString('base64'),
        mimeType: contentType.startsWith('image/') ? contentType : 'image/png',
        width: null,
        height: null,
        fileName: url.split('/').pop() || 'extra-reference.png',
        source: 'extra_url',
        sourceId: url,
        sourceName: 'Extra Reference',
      });
    } catch (error) {
      console.warn(`[Studio Generation] Failed to load extra reference image from ${url}:`, error);
    }
  }

  return images;
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

  let contextText = 'Context: The following images are reference material.\n\n';

  for (const images of groups.values()) {
    const first = images[0];
    const count = images.length;
    
    if (first.source === 'product') {
      contextText += `Product '${first.sourceName}':\n`;
      if (first.description) {
        contextText += `Description: ${first.description}\n`;
      }
      contextText += `The following ${count} image${count > 1 ? 's' : ''} show${count > 1 ? '' : 's'} this product from multiple angles. Use them to maintain the exact shape, texture, material, and design. Do NOT create a collage. Generate a single coherent image of this product.\n\n`;
    } else if (first.source === 'persona') {
      contextText += `Persona '${first.sourceName}':\n`;
      if (first.description) {
        contextText += `Description: ${first.description}\n`;
      }
      contextText += `The following ${count} image${count > 1 ? 's' : ''} show${count > 1 ? '' : 's'} this person from various angles and expressions. Use them to maintain the exact facial features, body shape, clothing, and appearance. Do NOT create a collage. Generate a single coherent image of this person.\n\n`;
    } else if (first.source === 'source_output') {
      contextText += `Source Image:\n`;
      contextText += `The following ${count} image${count > 1 ? 's' : ''} ${count > 1 ? 'are' : 'is'} the previously generated output that should be used as the base for editing or variation.\n\n`;
    } else if (first.source === 'extra_url') {
      contextText += `Additional Reference Images:\n`;
      contextText += `The following ${count} image${count > 1 ? 's' : ''} provide additional visual context or style reference.\n\n`;
    }
  }

  contextText += `User instruction: `;

  return { contextText, providerImages };
}

export async function executeStudioGeneration(
  userId: string,
  request: StudioGenerateRequest,
): Promise<StudioGenerateResult> {
  const mode = request.mode || 'image';
  const providerId = request.provider || 'gemini';
  const aspectRatio = request.aspect_ratio || '1:1';
  const rawPrompt = sanitizePrompt(request.prompt);
  const productIds = (request.product_ids || []).slice(0, MAX_PRODUCTS);
  const personaIds = (request.persona_ids || []).slice(0, MAX_PERSONAS);

  if (!rawPrompt && productIds.length === 0 && personaIds.length === 0 && !request.source_output_id && !(request.extra_reference_urls?.length)) {
    throw new StudioServiceError(
      'Prompt or reference required',
      'Ein Prompt oder mindestens ein Referenz-Bild (Produkt/Persona) ist erforderlich.',
    );
  }

  const generationId = randomUUID();
  const now = new Date();
  let sourceGenerationId: string | null = null;

  const defaultModel = providerId === 'openai' ? 'gpt-image-1.5' : 'gemini-3.1-flash-image-preview';
  const model = request.mode === 'video'
    ? 'veo-3.1-fast-generate-preview'
    : (request.model || defaultModel);

  if (request.source_output_id) {
    const [sourceOutput] = await db.select({ generationId: studioGenerationOutputs.generationId })
      .from(studioGenerationOutputs)
      .where(eq(studioGenerationOutputs.id, request.source_output_id))
      .limit(1);
    sourceGenerationId = sourceOutput?.generationId ?? null;
  }

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
    piSessionId: request.pi_session_id ?? null,
    sourceGenerationId,
    metadata: null,
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

  try {
    const allReferenceImages: LoadedReferenceImage[] = [];

    if (request.source_output_id) {
      const sourceImg = await loadSourceOutputImage(request.source_output_id);
      allReferenceImages.push(sourceImg);

      if (productIds.length === 0 && personaIds.length === 0) {
        const [sourceOutput] = await db.select()
          .from(studioGenerationOutputs)
          .where(eq(studioGenerationOutputs.id, request.source_output_id));
        if (sourceOutput) {
          const sourceRefs = await loadSourceOutputReferences(sourceOutput.generationId);
          if (sourceRefs.product_ids.length > 0 || sourceRefs.persona_ids.length > 0) {
            const productImgs = await loadProductImages(sourceRefs.product_ids);
            const personaImgs = await loadPersonaImages(sourceRefs.persona_ids);
            for (const img of [...productImgs, ...personaImgs]) {
              if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
                allReferenceImages.push(img);
              }
            }
          }
        }
      }
    }

    const productImgs = await loadProductImages(productIds);
    const personaImgs = await loadPersonaImages(personaIds);
    for (const img of [...productImgs, ...personaImgs]) {
      if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
        allReferenceImages.push(img);
      }
    }

    // Load extra reference images from URLs
    const extraUrls = request.extra_reference_urls || [];
    if (extraUrls.length > 0) {
      const extraImgs = await loadExtraReferenceImages(extraUrls);
      for (const img of extraImgs) {
        if (!allReferenceImages.some((r) => r.imageBytes === img.imageBytes)) {
          allReferenceImages.push(img);
        }
      }
    }

    // Build structured context prompt for all references
    const { contextText, providerImages } = buildReferenceContextPrompt(allReferenceImages);

    let composedPrompt = rawPrompt;
    if (request.preset_id) {
      const presetFragment = await composePresetPromptFragment(request.preset_id);
      if (presetFragment) {
        composedPrompt = `${presetFragment} ${rawPrompt}`.trim();
      }
    }

    // Note: contextText is passed separately to providers for structured injection
    // OpenAI will prepend it to the prompt, Gemini will use it as a separate text part

    await db.update(studioGenerations)
      .set({ status: 'generating', updatedAt: new Date() })
      .where(eq(studioGenerations.id, generationId));

    let outputs: StudioGenerationOutput[];

    if (mode === 'video') {
      outputs = await generateStudioVideo(generationId, composedPrompt, aspectRatio, providerImages);
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
    await db.update(studioGenerations)
      .set({ status: 'failed', metadata: JSON.stringify({ error: errorMessage }), updatedAt: new Date() })
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
      await db.insert(studioGenerationOutputs).values({
        id: outputId,
        generationId,
        variationIndex: index,
        type: 'image',
        filePath: outputPath,
        mediaUrl: toMediaUrl(outputPath),
        fileSize: outputBytes.length,
        mimeType: result.mimeType,
        width: null,
        height: null,
        isFavorite: false,
        piSessionId: null,
        metadata: null,
        createdAt: now,
      });

      return {
        id: outputId,
        variationIndex: index,
        filePath: outputPath,
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
        mediaUrl: null,
        fileSize: null,
        mimeType: null,
        width: null,
        height: null,
        isFavorite: false,
        piSessionId: null,
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
): Promise<StudioGenerationOutput[]> {
  if (!prompt) {
    throw new StudioServiceError(
      'Prompt required for video generation',
      'Ein Prompt ist für Video-Generierung erforderlich.',
    );
  }

  const videoAspect = aspectRatio === '9:16' ? '9:16' as const : '16:9' as const;

  const requestBody: GenerateVideoRequestBody = {
    prompt,
    mode: referenceImages.length > 0 ? 'references_to_video' : 'text_to_video',
    aspectRatio: videoAspect,
    resolution: '720p',
    referenceImagePaths: [],
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
    mediaUrl: videoResult.mediaUrl,
    fileSize,
    mimeType: 'video/mp4',
    width: null,
    height: null,
    isFavorite: false,
    piSessionId: null,
    metadata: null,
    createdAt: now,
  });

  return [{
    id: outputId,
    variationIndex: 0,
    filePath: videoPath,
    mediaUrl: videoResult.mediaUrl,
    mimeType: 'video/mp4',
    fileSize: fileSize ?? 0,
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

    return {
      ...gen,
      outputs,
      product_ids: productRefs.map((r) => r.productId),
      persona_ids: personaRefs.map((r) => r.personaId),
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

  return {
    ...generation,
    outputs,
    product_ids: productRefs.map((r) => r.productId),
    persona_ids: personaRefs.map((r) => r.personaId),
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
