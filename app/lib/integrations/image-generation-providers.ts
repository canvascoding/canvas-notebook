import 'server-only';

import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { EnvStorageScope } from './env-config';
import {
  GEMINI_FLASH_IMAGE_MODEL_ID,
  GEMINI_PRO_IMAGE_MODEL_ID,
  BACKGROUND_OPTIONS,
  OPENAI_INPUT_FIDELITY_OPTIONS,
  OPENAI_IMAGE_MODEL_ID,
  OPENAI_MODERATION_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  getDefaultOpenAIImageSize,
  getOpenAIImageSizeValidationError,
  normalizeGeminiImageModelId,
  normalizeOpenAIImageOutputFormat,
  type OpenAIImageBackground,
  type OpenAIImageInputFidelity,
  type OpenAIImageModeration,
  type OpenAIImageOutputFormat,
  type OpenAIImageQuality,
} from './image-generation-constants';
import { generateManagedMedia, isManagedMediaFallbackAvailable } from './managed-media-client';
import { resolveStudioProviderCredential } from './studio-provider-credentials';

export interface ImageModelOption {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
}

export interface ImageGenerationProvider {
  id: string;
  name: string;
  requiredApiKey: string;
  models: ImageModelOption[];
  supportedAspectRatios: string[];
  maxReferenceImages: number;
  maxImageCount: number;
  supportsQuality: boolean;
  supportsOutputFormat: boolean;
  supportsBackground: boolean;
  supportsImageSize: boolean;
  getMaxReferenceImages(model: string): number;
  generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult>;
}

export interface ProviderImageInput {
  imageBytes: string;
  mimeType: string;
  fileName?: string;
}

export interface ProviderGenerateParams {
  prompt: string;
  model: string;
  aspectRatio: string;
  referenceImages: ProviderImageInput[];
  editMask?: ProviderImageInput;
  quality?: OpenAIImageQuality;
  outputFormat?: OpenAIImageOutputFormat;
  background?: OpenAIImageBackground;
  moderation?: OpenAIImageModeration;
  outputCompression?: number;
  inputFidelity?: OpenAIImageInputFidelity;
  stream?: boolean;
  partialImages?: number;
  endUserId?: string;
  contextPrompt?: string;
  imageSize?: string;
  storageScope?: EnvStorageScope | null;
}

export interface ProviderGenerateResult {
  imageBytes: string;
  mimeType: string;
  usage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
}

const GEMINI_MODELS: ImageModelOption[] = [
  {
    id: GEMINI_FLASH_IMAGE_MODEL_ID,
    label: '🎨 Best Quality & Features',
    shortLabel: 'Gemini 3.1 Flash Image',
    description: 'Latest model with the highest quality and more capabilities. Supports up to 14 reference images and advanced features like grounding. Best for professional results.',
  },
  {
    id: GEMINI_PRO_IMAGE_MODEL_ID,
    label: '🎯 Pro Quality & Reasoning',
    shortLabel: 'Nano Banana Pro',
    description: 'Professional asset production model with advanced reasoning for complex instructions and high-fidelity text rendering. Supports up to 14 reference images and 2K resolution output.',
  },
];

const OPENAI_MODELS: ImageModelOption[] = [
  {
    id: OPENAI_IMAGE_MODEL_ID,
    label: '🎨 Best Quality',
    shortLabel: 'GPT Image 2.5 Sunburst',
    description: 'OpenAI\'s most capable image model, optimized for generation and precise reference-based editing.',
  },
];

const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const OPENAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'auto'];

function extractUsage(usage: unknown): ProviderGenerateResult['usage'] {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as unknown as Record<string, unknown>;
  const totalTokens = typeof u.total_tokens === 'number' ? u.total_tokens : undefined;
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  if (totalTokens === undefined && inputTokens === undefined && outputTokens === undefined) return undefined;
  return { totalTokens: totalTokens ?? 0, inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

async function extractOpenAIImage(
  response: unknown,
): Promise<{ imageBytes: string; usage?: ProviderGenerateResult['usage'] }> {
  if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
    let completedImage: string | undefined;
    let completedUsage: ProviderGenerateResult['usage'];
    for await (const event of response as AsyncIterable<unknown>) {
      if (!event || typeof event !== 'object') continue;
      const item = event as Record<string, unknown>;
      if (
        (item.type === 'image_generation.completed' || item.type === 'image_edit.completed')
        && typeof item.b64_json === 'string'
      ) {
        completedImage = item.b64_json;
        completedUsage = extractUsage(item.usage);
      }
    }
    if (completedImage) {
      return { imageBytes: completedImage, usage: completedUsage };
    }
    throw new Error('No final image was returned by OpenAI');
  }

  const result = response as { data?: Array<{ b64_json?: string }>; usage?: unknown };
  const imageBytes = result.data?.[0]?.b64_json;
  if (!imageBytes) {
    throw new Error('No image was returned by OpenAI');
  }
  return { imageBytes, usage: extractUsage(result.usage) };
}

function buildOpenAIImagePrompt(prompt: string, contextPrompt?: string): string {
  const instruction = (prompt || 'Edit this image').slice(0, 32_000);
  if (!contextPrompt) return instruction;

  const separator = '\n\n';
  const contextBudget = Math.max(0, 32_000 - instruction.length - separator.length);
  if (contextBudget === 0) return instruction;
  return `${contextPrompt.slice(0, contextBudget)}${separator}${instruction}`;
}

function extractInlineImage(response: unknown): { imageBytes: string; mimeType: string } {
  const candidates = (
    response as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }>;
    }
  ).candidates;

  for (const candidate of candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        return {
          imageBytes: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
    }
  }

  const fallback = response as { data?: string };
  if (fallback.data) {
    return { imageBytes: fallback.data, mimeType: 'image/png' };
  }

  console.error(`[Gemini Image] No image in response. Response structure:`, JSON.stringify(response, null, 2).slice(0, 2000));
  throw new Error('No image was returned by the model');
}

class GeminiImageProvider implements ImageGenerationProvider {
  id = 'gemini';
  name = 'Google Gemini';
  requiredApiKey = 'GEMINI_API_KEY';
  models = GEMINI_MODELS;
  supportedAspectRatios = GEMINI_ASPECT_RATIOS;
  maxReferenceImages = 10;
  maxImageCount = 4;
  supportsQuality = false;
  supportsOutputFormat = false;
  supportsBackground = false;
  supportsImageSize = true;

  getMaxReferenceImages(model: string): number {
    const normalizedModel = normalizeGeminiImageModelId(model);
    if (normalizedModel === GEMINI_FLASH_IMAGE_MODEL_ID) {
      return 14;
    }
    if (normalizedModel === GEMINI_PRO_IMAGE_MODEL_ID) {
      return 14;
    }
    return this.maxReferenceImages;
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const model = normalizeGeminiImageModelId(params.model);
    const apiKey = await resolveStudioProviderCredential('gemini', params.storageScope);
    if (!apiKey) {
      if (isManagedMediaFallbackAvailable()) {
        console.log(`[Gemini Image] Using managed fallback: model=${model}, aspectRatio=${params.aspectRatio}, refs=${params.referenceImages.length}`);
        const result = await generateManagedMedia({
          capability: 'image',
          provider: 'gemini',
          model,
          prompt: params.prompt,
          parameters: {
            aspectRatio: params.aspectRatio,
            contextPrompt: params.contextPrompt,
            imageSize: params.imageSize,
            hasEditMask: Boolean(params.editMask),
          },
          references: params.referenceImages,
        });
        const output = result.outputs[0];
        if (!output) throw new Error('No image was returned by managed Gemini');
        console.log(`[Gemini Image] Managed fallback completed: job=${result.jobId}, mime=${output.mimeType}, bytes=${output.bytes.length}`);
        return {
          imageBytes: output.bytes.toString('base64'),
          mimeType: output.mimeType,
          usage: output.metadata?.usage as ProviderGenerateResult['usage'],
        };
      }
      throw new Error('Gemini API key is missing. Configure GEMINI_API_KEY in /settings.');
    }

    console.log(`[Gemini Image] Generating: model=${model}, aspectRatio=${params.aspectRatio}, refs=${params.referenceImages.length}, contextPrompt=${params.contextPrompt ? 'yes' : 'no'}, prompt="${params.prompt.slice(0, 80)}..."`);

    const ai = new GoogleGenAI({ apiKey });

    const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [];

    // Inject context prompt as first text part if available
    if (params.contextPrompt) {
      parts.push({ text: params.contextPrompt });
    }

    for (const image of params.referenceImages) {
      parts.push({
        inlineData: {
          data: image.imageBytes,
          mimeType: image.mimeType,
        },
      });
    }

    if (params.prompt) {
      parts.push({ text: params.prompt });
    }

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig: {
          aspectRatio: params.aspectRatio,
          ...(params.imageSize ? { imageSize: params.imageSize } : {}),
        },
      },
    });

    console.log(`[Gemini Image] Response received: candidates=${(response as { candidates?: unknown[] })?.candidates?.length ?? 'N/A'}, hasInlineData=${JSON.stringify((response as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: unknown }> } }> })?.candidates?.[0]?.content?.parts?.map(p => !!p.inlineData) ?? 'unknown')}`);

    const generated = extractInlineImage(response);
    return {
      imageBytes: generated.imageBytes,
      mimeType: generated.mimeType,
    };
  }
}

class OpenAIImageProvider implements ImageGenerationProvider {
  id = 'openai';
  name = 'OpenAI GPT Image';
  requiredApiKey = 'OPENAI_API_KEY';
  models = OPENAI_MODELS;
  supportedAspectRatios = OPENAI_ASPECT_RATIOS;
  maxReferenceImages = 16;
  maxImageCount = 10;
  supportsQuality = true;
  supportsOutputFormat = true;
  supportsBackground = true;
  supportsImageSize = true;

  getMaxReferenceImages(): number {
    return this.maxReferenceImages;
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    if (params.quality !== undefined && !QUALITY_OPTIONS.includes(params.quality)) {
      throw new Error('Unsupported OpenAI image quality.');
    }
    if (params.outputFormat !== undefined && !OUTPUT_FORMAT_OPTIONS.includes(params.outputFormat)) {
      throw new Error('Unsupported OpenAI output format.');
    }
    if (params.background !== undefined && !BACKGROUND_OPTIONS.includes(params.background)) {
      throw new Error('Unsupported OpenAI background.');
    }
    if (params.moderation !== undefined && !OPENAI_MODERATION_OPTIONS.includes(params.moderation)) {
      throw new Error('Unsupported OpenAI moderation level.');
    }
    if (params.inputFidelity !== undefined && !OPENAI_INPUT_FIDELITY_OPTIONS.includes(params.inputFidelity)) {
      throw new Error('Unsupported OpenAI input fidelity.');
    }
    const outputFormat = normalizeOpenAIImageOutputFormat(params.background, params.outputFormat) || 'png';
    const size = (params.imageSize || getDefaultOpenAIImageSize(params.aspectRatio)).trim().toLowerCase();
    const sizeError = getOpenAIImageSizeValidationError(size);
    if (sizeError) {
      throw new Error(`Invalid OpenAI image size "${size}": ${sizeError}`);
    }
    if (
      params.outputCompression !== undefined
      && (!Number.isInteger(params.outputCompression) || params.outputCompression < 0 || params.outputCompression > 100)
    ) {
      throw new Error('OpenAI output compression must be an integer between 0 and 100.');
    }
    if (
      params.partialImages !== undefined
      && (!Number.isInteger(params.partialImages) || params.partialImages < 0 || params.partialImages > 3)
    ) {
      throw new Error('OpenAI partial image count must be an integer between 0 and 3.');
    }
    if (params.partialImages !== undefined && !params.stream) {
      throw new Error('OpenAI partial images require streaming mode.');
    }
    const outputCompression = outputFormat === 'jpeg' || outputFormat === 'webp'
      ? params.outputCompression
      : undefined;

    const apiKey = await resolveStudioProviderCredential('openai', params.storageScope);
    if (!apiKey) {
      if (isManagedMediaFallbackAvailable()) {
        console.log(`[OpenAI Image] Using managed fallback: model=${params.model}, aspectRatio=${params.aspectRatio}, refs=${params.referenceImages.length}, quality=${params.quality || 'auto'}`);
        const result = await generateManagedMedia({
          capability: 'image',
          provider: 'openai',
          model: params.model,
          prompt: params.prompt,
          parameters: {
            aspectRatio: params.aspectRatio,
            contextPrompt: params.contextPrompt,
            quality: params.quality,
            outputFormat,
            background: params.background,
            moderation: params.moderation,
            outputCompression,
            inputFidelity: params.inputFidelity,
            stream: params.stream,
            partialImages: params.partialImages,
            endUserId: params.endUserId,
            imageSize: size,
            editMaskReferenceIndex: params.editMask ? params.referenceImages.length : undefined,
          },
          references: params.editMask
            ? [...params.referenceImages, { ...params.editMask, role: 'reference_image' }]
            : params.referenceImages,
        });
        const output = result.outputs[0];
        if (!output) throw new Error('No image was returned by managed OpenAI');
        console.log(`[OpenAI Image] Managed fallback completed: job=${result.jobId}, mime=${output.mimeType}, bytes=${output.bytes.length}`);
        return {
          imageBytes: output.bytes.toString('base64'),
          mimeType: output.mimeType,
          usage: output.metadata?.usage as ProviderGenerateResult['usage'],
        };
      }
      throw new Error('OpenAI API key is missing. Configure OPENAI_API_KEY in /settings.');
    }

    console.log(`[OpenAI Image] Generating: model=${params.model}, aspectRatio=${params.aspectRatio}, refs=${params.referenceImages.length}, quality=${params.quality || 'auto'}`);

    const openai = new OpenAI({ apiKey });

    const hasReferences = params.referenceImages.length > 0;
    // Combine context prompt and user prompt for OpenAI
    const fullPrompt = buildOpenAIImagePrompt(params.prompt, params.contextPrompt);

    if (hasReferences) {
      const imageBuffers = params.referenceImages.map((img) => {
        const buffer = Buffer.from(img.imageBytes, 'base64');
        return new File([buffer], img.fileName || `image.${img.mimeType.split('/')[1] || 'png'}`, { type: img.mimeType });
      });
      const maskFile = params.editMask
        ? new File(
          [Buffer.from(params.editMask.imageBytes, 'base64')],
          params.editMask.fileName || `mask.${params.editMask.mimeType.split('/')[1] || 'png'}`,
          { type: params.editMask.mimeType },
        )
        : undefined;

      const request = {
        model: params.model,
        prompt: fullPrompt,
        image: imageBuffers.length === 1 ? imageBuffers[0] : imageBuffers,
        ...(maskFile ? { mask: maskFile } : {}),
        size,
        quality: params.quality || 'auto',
        output_format: outputFormat,
        background: params.background || 'auto',
        moderation: params.moderation || 'auto',
        ...(outputCompression !== undefined
          ? { output_compression: outputCompression }
          : {}),
        ...(params.inputFidelity ? { input_fidelity: params.inputFidelity } : {}),
        ...(params.endUserId ? { user: params.endUserId } : {}),
        ...(params.stream ? { stream: true, partial_images: params.partialImages ?? 0 } : { stream: false }),
        n: 1,
      };
      // The API launched before the generated SDK union included the 2.5 model's
      // xhigh/max quality literals, so keep the runtime request authoritative here.
      const result = await openai.images.edit(request as never);
      const image = await extractOpenAIImage(result);

      return {
        imageBytes: image.imageBytes,
        mimeType: `image/${outputFormat}`,
        usage: image.usage,
      };
    }

    const request = {
      model: params.model,
      prompt: fullPrompt,
      n: 1,
      size,
      quality: params.quality || 'auto',
      output_format: outputFormat,
      background: params.background || 'auto',
      moderation: params.moderation || 'auto',
      ...(outputCompression !== undefined
        ? { output_compression: outputCompression }
        : {}),
      ...(params.endUserId ? { user: params.endUserId } : {}),
      ...(params.stream ? { stream: true, partial_images: params.partialImages ?? 0 } : { stream: false }),
    };
    const result = await openai.images.generate(request as never);
    const image = await extractOpenAIImage(result);

    return {
      imageBytes: image.imageBytes,
      mimeType: `image/${outputFormat}`,
      usage: image.usage,
    };
  }
}

const PROVIDER_REGISTRY: Record<string, ImageGenerationProvider> = {
  gemini: new GeminiImageProvider(),
  openai: new OpenAIImageProvider(),
};

export function getImageGenerationProvider(providerId: string): ImageGenerationProvider | null {
  return PROVIDER_REGISTRY[providerId] || null;
}

export function getAllProviders(): ImageGenerationProvider[] {
  return Object.values(PROVIDER_REGISTRY);
}

export function getProviderModels(providerId: string): ImageModelOption[] {
  const provider = PROVIDER_REGISTRY[providerId];
  return provider ? provider.models : [];
}
