import 'server-only';

import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { getGeminiApiKeyFromIntegrations, getOpenAIApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import {
  IMAGE_GENERATION_OUTPUT_DIR,
  createImageGenerationOutputFilename,
  ensureImageGenerationWorkspace,
} from '@/app/lib/integrations/image-generation-workspace';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';
import {
  getImageGenerationProvider,
} from '@/app/lib/integrations/image-generation-providers';
import { loadMediaReference } from '@/app/lib/integrations/media-reference-resolver';

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const MAX_PROMPT_LENGTH_GEMINI = 3_000;
const MAX_PROMPT_LENGTH_OPENAI = 32_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export const IMAGE_GENERATION_ALL_FAILED_MESSAGE = 'Image generation failed for all requested variations.';

export interface GenerateImageRequestBody {
  prompt?: string;
  provider?: string;
  model?: string;
  aspectRatio?: string;
  imageCount?: number;
  referenceImagePaths?: string[];
  quality?: 'low' | 'medium' | 'high' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
}

export interface GeneratedImageResult {
  index: number;
  path?: string;
  metadataPath?: string;
  mediaUrl?: string;
  previewUrl?: string;
  error?: string;
}

export interface ImageGenerationResultData {
  model: string;
  provider: string;
  aspectRatio: string;
  imageCount: number;
  outputDir: string;
  successCount: number;
  failureCount: number;
  results: GeneratedImageResult[];
}

function sanitizePrompt(prompt: string, maxPromptLength: number): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, maxPromptLength);
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Image generation failed';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function normalizeReferencePaths(input: string[], maxReferences: number): string[] {
  const list: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of input) {
    const filePath = rawPath.trim();
    if (!filePath) {
      continue;
    }

    if (seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    list.push(filePath);
    if (list.length >= maxReferences) {
      break;
    }
  }

  return list;
}

async function loadImageBytes(filePath: string): Promise<{ imageBytes: string; mimeType: string }> {
  try {
    const file = await loadMediaReference(filePath, {
      allowedTypes: ['image'],
      maxBytes: MAX_REFERENCE_IMAGE_BYTES,
    });
    return {
      imageBytes: file.imageBytes,
      mimeType: file.mimeType,
    };
  } catch (error) {
    throw new IntegrationServiceError(error instanceof Error ? error.message : `Reference image could not be loaded: ${filePath}`, 400);
  }
}

function extensionFromMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType] || 'png';
}

async function getProviderApiKey(providerId: string): Promise<string | null> {
  if (providerId === 'gemini') {
    return getGeminiApiKeyFromIntegrations();
  }
  if (providerId === 'openai') {
    return getOpenAIApiKeyFromIntegrations();
  }
  return null;
}

export async function generateImages(
  body: GenerateImageRequestBody,
  callerEmail = 'system',
): Promise<ImageGenerationResultData> {
  const providerId = body.provider || 'gemini';
  const provider = getImageGenerationProvider(providerId);

  if (!provider) {
    throw new IntegrationServiceError(`Unsupported provider: ${providerId}`, 400);
  }

  const modelCandidate = (body.model || provider.models[0]?.id || '').trim();
  if (!provider.models.some((m) => m.id === modelCandidate)) {
    throw new IntegrationServiceError(`Unsupported model "${modelCandidate}" for provider "${providerId}".`, 400);
  }

  const aspectRatio = body.aspectRatio || '1:1';
  if (!provider.supportedAspectRatios.includes(aspectRatio)) {
    throw new IntegrationServiceError(`Unsupported aspect ratio "${aspectRatio}" for provider "${providerId}".`, 400);
  }

  const maxImageCount = provider.maxImageCount;
  const imageCount = (() => {
    if (body.imageCount === undefined) return Math.min(1, maxImageCount);
    if (!Number.isInteger(body.imageCount)) return null;
    if (body.imageCount < 1 || body.imageCount > maxImageCount) return null;
    return body.imageCount;
  })();

  if (!imageCount) {
    throw new IntegrationServiceError(`imageCount must be between 1 and ${maxImageCount}.`, 400);
  }

  const maxReferenceImages = provider.getMaxReferenceImages(modelCandidate);
  const referenceImagePaths = normalizeReferencePaths(body.referenceImagePaths || [], maxReferenceImages);

  const maxPromptLength = providerId === 'openai' ? MAX_PROMPT_LENGTH_OPENAI : MAX_PROMPT_LENGTH_GEMINI;
  const prompt = sanitizePrompt(body.prompt || '', maxPromptLength);

  if (!prompt && referenceImagePaths.length === 0) {
    throw new IntegrationServiceError('Prompt or at least one reference image is required.', 400);
  }

  if (provider.supportsQuality && body.quality && !['low', 'medium', 'high', 'auto'].includes(body.quality)) {
    throw new IntegrationServiceError('Invalid quality value. Must be low, medium, high, or auto.', 400);
  }
  if (provider.supportsOutputFormat && body.outputFormat && !['png', 'jpeg', 'webp'].includes(body.outputFormat)) {
    throw new IntegrationServiceError('Invalid outputFormat value. Must be png, jpeg, or webp.', 400);
  }
  if (provider.supportsBackground && body.background && !['transparent', 'opaque', 'auto'].includes(body.background)) {
    throw new IntegrationServiceError('Invalid background value. Must be transparent, opaque, or auto.', 400);
  }
  if (!provider.supportsQuality && body.quality) {
    throw new IntegrationServiceError(`Provider "${providerId}" does not support the quality parameter.`, 400);
  }
  if (!provider.supportsOutputFormat && body.outputFormat) {
    throw new IntegrationServiceError(`Provider "${providerId}" does not support the outputFormat parameter.`, 400);
  }
  if (!provider.supportsBackground && body.background) {
    throw new IntegrationServiceError(`Provider "${providerId}" does not support the background parameter.`, 400);
  }

  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) {
    throw new IntegrationServiceError(
      `${provider.name} API key is missing. Configure ${provider.requiredApiKey} in /settings.`,
      400,
    );
  }

  const referenceImages = await Promise.all(referenceImagePaths.map((filePath) => loadImageBytes(filePath)));

  await ensureImageGenerationWorkspace();

  const generationJobs = Array.from({ length: imageCount }, async (_, index): Promise<GeneratedImageResult> => {
    try {
      const result = await provider.generate({
        prompt,
        model: modelCandidate,
        aspectRatio,
        referenceImages,
        quality: body.quality,
        outputFormat: body.outputFormat,
        background: body.background,
      });

      const extension = extensionFromMime(result.mimeType);
      const outputFilename = createImageGenerationOutputFilename(prompt || 'reference', index, extension);
      const outputPath = `${IMAGE_GENERATION_OUTPUT_DIR}/${outputFilename}`;
      const outputBytes = Buffer.from(result.imageBytes, 'base64');
      await writeFile(outputPath, outputBytes);

      const metadataPath = outputPath.replace(/\.[^.]+$/, '.json');
      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            createdBy: callerEmail,
            provider: providerId,
            model: modelCandidate,
            aspectRatio,
            prompt,
            referenceImagePaths,
            variationIndex: index,
            output: {
              path: outputPath,
              mimeType: result.mimeType,
              size: outputBytes.length,
            },
            usage: result.usage || undefined,
          },
          null,
          2,
        ),
      );

      return {
        index,
        path: outputPath,
        metadataPath,
        mediaUrl: toMediaUrl(outputPath),
        previewUrl: toPreviewUrl(outputPath, 1280),
      };
    } catch (error) {
      return {
        index,
        error: sanitizeErrorMessage(error),
      };
    }
  });

  const results = await Promise.all(generationJobs);
  const successCount = results.filter((item) => !item.error).length;
  const failureCount = results.length - successCount;

  return {
    model: modelCandidate,
    provider: providerId,
    aspectRatio,
    imageCount,
    outputDir: IMAGE_GENERATION_OUTPUT_DIR,
    successCount,
    failureCount,
    results,
  };
}
