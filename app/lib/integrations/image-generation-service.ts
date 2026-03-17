import 'server-only';

import path from 'path';
import { GoogleGenAI } from '@google/genai';

import { getFileStats, readFile, writeFile } from '@/app/lib/filesystem/workspace-files';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { getGeminiApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import {
  IMAGE_GENERATION_OUTPUT_DIR,
  createImageGenerationOutputFilename,
  ensureImageGenerationWorkspace,
} from '@/app/lib/integrations/image-generation-workspace';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const ALLOWED_MODELS = new Set(['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']);
const ALLOWED_ASPECT_RATIOS = new Set(['16:9', '1:1', '9:16', '4:3', '3:4']);
const MAX_PROMPT_LENGTH = 3_000;
const MAX_IMAGE_COUNT = 4;
const MAX_REFERENCE_IMAGES = 10;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 300;

export const IMAGE_GENERATION_ALL_FAILED_MESSAGE = 'Image generation failed for all requested variations.';

export interface GenerateImageRequestBody {
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  imageCount?: number;
  referenceImagePaths?: string[];
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
  aspectRatio: string;
  imageCount: number;
  outputDir: string;
  successCount: number;
  failureCount: number;
  results: GeneratedImageResult[];
}

function extensionFromPath(filePath: string): string {
  const ext = filePath.split('.').pop();
  return ext ? ext.toLowerCase() : '';
}

function resolveImageMime(filePath: string): string {
  const ext = extensionFromPath(filePath);
  const mime = IMAGE_MIME[ext];
  if (!mime) {
    throw new IntegrationServiceError(`Unsupported reference image format: ${ext || 'unknown'}`, 400);
  }
  return mime;
}

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_LENGTH);
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Image generation failed';
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function resolveAspectRatio(value: string | undefined): string | null {
  if (!value) return '1:1';
  return ALLOWED_ASPECT_RATIOS.has(value) ? value : null;
}

function resolveModel(value: string | undefined): string | null {
  const candidate = (value || 'gemini-3.1-flash-image-preview').trim();
  return ALLOWED_MODELS.has(candidate) ? candidate : null;
}

function resolveImageCount(value: number | undefined): number | null {
  if (value === undefined) return MAX_IMAGE_COUNT;
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_IMAGE_COUNT) return null;
  return value;
}

function normalizeReferencePaths(input: string[]): string[] {
  const list: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of input) {
    const filePath = rawPath.trim();
    if (!filePath) {
      continue;
    }

    const normalizedPath = path.posix.normalize(filePath).replace(/^\.?\//, '');
    if (
      !normalizedPath ||
      normalizedPath === '.' ||
      normalizedPath.startsWith('/') ||
      normalizedPath.startsWith('../') ||
      normalizedPath.includes('/../')
    ) {
      continue;
    }

    const extension = extensionFromPath(normalizedPath);
    if (!IMAGE_MIME[extension]) {
      continue;
    }

    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    list.push(normalizedPath);
    if (list.length >= MAX_REFERENCE_IMAGES) {
      break;
    }
  }

  return list;
}

async function loadImageBytes(filePath: string): Promise<{ imageBytes: string; mimeType: string }> {
  const mimeType = resolveImageMime(filePath);
  const stats = await getFileStats(filePath);
  if (!stats.isFile) {
    throw new IntegrationServiceError(`Not a file: ${filePath}`, 400);
  }
  if (stats.size <= 0) {
    throw new IntegrationServiceError(`Reference image is empty: ${filePath}`, 400);
  }
  if (stats.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new IntegrationServiceError(`Reference image too large: ${filePath}`, 400);
  }

  const content = await readFile(filePath);
  return {
    imageBytes: content.toString('base64'),
    mimeType,
  };
}

function extractInlineImage(response: unknown): { imageBytes: string; mimeType: string } {
  const candidates = (
    response as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>;
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

  throw new Error('No image was returned by the model');
}

function extensionFromMime(mimeType: string): string {
  return MIME_EXTENSION[mimeType] || 'png';
}

export async function generateImages(
  body: GenerateImageRequestBody,
  callerEmail = 'system',
): Promise<ImageGenerationResultData> {
  const apiKey = await getGeminiApiKeyFromIntegrations();
  if (!apiKey) {
    throw new IntegrationServiceError('Gemini API key is missing. Configure GEMINI_API_KEY in /settings.', 400);
  }

  const prompt = sanitizePrompt(body.prompt || '');
  const model = resolveModel(body.model);
  const aspectRatio = resolveAspectRatio(body.aspectRatio);
  const imageCount = resolveImageCount(body.imageCount);
  const referenceImagePaths = normalizeReferencePaths(body.referenceImagePaths || []);

  if (!model) {
    throw new IntegrationServiceError('Unsupported model.', 400);
  }
  if (!aspectRatio) {
    throw new IntegrationServiceError('Unsupported aspect ratio.', 400);
  }
  if (!imageCount) {
    throw new IntegrationServiceError(`imageCount must be between 1 and ${MAX_IMAGE_COUNT}.`, 400);
  }
  if (!prompt && referenceImagePaths.length === 0) {
    throw new IntegrationServiceError('Prompt or at least one reference image is required.', 400);
  }

  const referenceImages = await Promise.all(referenceImagePaths.map((filePath) => loadImageBytes(filePath)));

  await ensureImageGenerationWorkspace();
  const ai = new GoogleGenAI({ apiKey });

  const generationJobs = Array.from({ length: imageCount }, async (_, index): Promise<GeneratedImageResult> => {
    try {
      const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [];

      for (const image of referenceImages) {
        parts.push({
          inlineData: {
            data: image.imageBytes,
            mimeType: image.mimeType,
          },
        });
      }

      if (prompt) {
        parts.push({ text: prompt });
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
            aspectRatio,
            imageSize: '1K',
          },
        },
      });

      const generated = extractInlineImage(response);
      const extension = extensionFromMime(generated.mimeType);
      const outputFilename = createImageGenerationOutputFilename(prompt || 'reference', index, extension);
      const outputPath = `${IMAGE_GENERATION_OUTPUT_DIR}/${outputFilename}`;
      const outputBytes = Buffer.from(generated.imageBytes, 'base64');
      await writeFile(outputPath, outputBytes);

      const metadataPath = outputPath.replace(/\.[^.]+$/, '.json');
      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            createdBy: callerEmail,
            model,
            aspectRatio,
            prompt,
            referenceImagePaths,
            variationIndex: index,
            output: {
              path: outputPath,
              mimeType: generated.mimeType,
              size: outputBytes.length,
            },
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
    model,
    aspectRatio,
    imageCount,
    outputDir: IMAGE_GENERATION_OUTPUT_DIR,
    successCount,
    failureCount,
    results,
  };
}
